// src/core/shims/install.mjs
//
// Side-effect-only. Importing this module installs every shim in the
// canonical order (J-007). This is the single file under `src/core/` that is
// deliberately allowed to execute top-level side effects — its sole purpose
// is install-on-import so that callers (notably `src/core/index.mjs`, J-008)
// can write a single `import "./shims/install.mjs"` at the top of the entry
// and trust that the runtime environment is ready for the Excalidraw bundle.
//
// Order (see the implementation notes, updated post-F-002, and the feasibility spike notes Findings B+C):
//
//   dom → web-globals → fonts → fetch-fonts → canvas → workers
//
// Rationale for the order:
// - `dom` installs linkedom `window`/`document` AND sets `devicePixelRatio`
//   (read at module-eval time by Excalidraw's renderer chunk, per Finding C).
//   It must run first because every downstream shim mirrors onto `window` or
//   wraps `document.createElement`.
// - `web-globals` polyfills URL, TextEncoder, Event, DOMException, etc. that
//   `deno_core` does not provide (Finding B). Must precede `fetch-fonts`
//   (which relies on `atob`) and `fonts` (which may touch `URL`).
// - `fonts` registers FontFace + document.fonts; `fetch-fonts` wraps `fetch`
//   and uses the font-assets map. `canvas` wraps `document.createElement`.
// - `workers` runs last so it latches `typeof Worker === "undefined"` right
//   before the Excalidraw bundle evaluates.
//
// Idempotency: each shim is internally idempotent, so calling this module's
// work twice (e.g. by a second `import`) is a safe no-op. ES module caching
// means a second `import` of this file won't re-run the installers at all.

import { installDomShim } from "./dom.mjs";
import { installWebGlobalsShim } from "./web-globals.mjs";
import { installFontsShim } from "./fonts.mjs";
import { installFetchFontsShim } from "./fetch-fonts.mjs";
import { installCanvasShim } from "./canvas.mjs";
import { installWorkersShim } from "./workers.mjs";

installDomShim();
installWebGlobalsShim();
installFontsShim();
installFetchFontsShim();
installCanvasShim();
installWorkersShim();
