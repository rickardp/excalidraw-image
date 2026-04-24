use deno_core::{serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions};
use serde::Deserialize;

const POLYFILLS: &str = include_str!("polyfills.js");

#[derive(Deserialize)]
struct RenderResult {
    svg: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let fixture_path = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: spike-rust <fixture.excalidraw>"))?;
    let scene_json = std::fs::read_to_string(&fixture_path)?;

    // include_str! the bundled core.mjs at compile time.
    let core_js_raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../spike/core.mjs"));

    // The bundle contains a handful of `import.meta.url` and `import.meta.env`
    // references (font-subset worker stub + jotai dev-mode warnings). We
    // rewrite them to literal stand-ins so we can evaluate the bundle as a
    // classic script. This avoids the ESM evaluation path which, under
    // deno_core 0.399's `load_main_es_module_from_code`, swallowed
    // synchronous throws without surfacing them via `mod_evaluate`'s error
    // channel. R-001 should either (a) `define` these away at esbuild time
    // in `src/scripts/build-core.mjs`, or (b) wire up proper ESM evaluation
    // with a custom `ModuleLoader`. For a spike, string-rewrite is enough.
    let core_js = core_js_raw
        .replace("import.meta.url", "\"file:///core.mjs\"")
        .replace("import.meta.env", "({MODE:\"production\",DEV:false,PROD:true})");

    let mut rt = JsRuntime::new(RuntimeOptions::default());

    // deno_core provides only a minimal runtime (console, queueMicrotask,
    // globalThis). Deno ships far more: atob/btoa, DOMException, URL,
    // TextEncoder/Decoder, Event, EventTarget, etc. The F-001 bundle was
    // designed assuming a Deno-like host, so several of these leaked in.
    //
    // For the spike we inject minimal JS-side polyfills covering only what
    // `basic-shapes` actually exercises. R-001 should either:
    //   (a) add these to `src/core/shims/install.mjs` so the bundle is truly
    //       host-neutral (preferred — the dependency graph is known at
    //       bundle time, so polyfills live with the consumer), OR
    //   (b) wire up the `deno_webidl` + `deno_url` + `deno_web` extensions
    //       from the Deno stack (matches Deno behavior byte-for-byte at the
    //       cost of tying us to version-matched deno_* crates).
    //
    // Scope of the spike polyfills below: everything that the bundle reads
    // at module-eval time for the basic-shapes fixture. Not exhaustive.
    rt.execute_script("preamble.js", POLYFILLS)?;

    rt.execute_script("core.mjs", core_js)?;

    // Trampoline: stash input as a global, then call __render.
    let setup = format!(
        "globalThis.__input = {};",
        serde_json::to_string(&scene_json)?,
    );
    rt.execute_script("setup.js", setup)?;

    let promise = rt.execute_script("call.js", "globalThis.__render(globalThis.__input)")?;

    // `resolve` no longer polls the event loop on its own in deno_core 0.399;
    // wrap with `with_event_loop_promise` so microtasks + timers fire.
    let resolve = rt.resolve(promise);
    let resolved = rt
        .with_event_loop_promise(Box::pin(resolve), PollEventLoopOptions::default())
        .await?;

    let result: RenderResult = {
        deno_core::scope!(scope, &mut rt);
        let local = v8::Local::new(scope, resolved);
        serde_v8::from_v8(scope, local)?
    };

    // Write to stdout. Deno's `dev.mjs` uses `console.log(svg)` which adds
    // a trailing '\n'; matching that here keeps stdout byte-identical
    // without any post-processing in the parity check.
    println!("{}", result.svg);
    Ok(())
}
