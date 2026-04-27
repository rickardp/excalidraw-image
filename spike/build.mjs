// spike/build.mjs — esbuild invocation for F-001.
//
// Run: node spike/build.mjs
//
// Produces:
//   spike/core.mjs   — the bundled output
//   spike/meta.json  — esbuild metafile for auditing

import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const emptyStub = path.join(repoRoot, "src/core/stubs/empty.mjs");

const minify = process.argv.includes("--minify");

// Stub modules we want to replace with an empty module. Using a resolve
// plugin is more reliable than `alias` for turning a bare specifier into
// an absolute path under platform=neutral.
//
// - react / react-dom / jotai: the original implementation plan step 2.
// - @excalidraw/mermaid-to-excalidraw: editor-only (MermaidToExcalidraw dialog).
//   Pulls in mermaid → vscode-jsonrpc → node:path/os/crypto, none of which
//   exportToSvg needs. Stubbing here keeps the bundle host-neutral.
// - @braintree/sanitize-url, image-blob-reduce, pica, png-chunk-text,
//   png-chunks-encode, png-chunks-extract, pwacompat, tunnel-rat, jotai-scope,
//   @radix-ui/*: editor/UI-only, added here pre-emptively only when the build
//   forces us to. Kept minimal for F-001.
const stubbed = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "jotai",
  "jotai-scope",
  "@excalidraw/mermaid-to-excalidraw",
  // Radix UI primitives are editor-only (popover/tabs). They do top-level
  // Object.assign on imported symbols, which breaks when those are stubbed
  // to undefined. Whole family is safe to stub out.
  "@radix-ui/react-popover",
  "@radix-ui/react-tabs",
  "@radix-ui/react-primitive",
  "@radix-ui/react-collection",
  "@radix-ui/react-context",
  "@radix-ui/react-compose-refs",
  "@radix-ui/react-use-controllable-state",
  "@radix-ui/react-dismissable-layer",
  "@radix-ui/react-focus-scope",
  "@radix-ui/react-focus-guards",
  "@radix-ui/react-portal",
  "@radix-ui/react-presence",
  "@radix-ui/react-roving-focus",
  "@radix-ui/react-slot",
  "@radix-ui/react-id",
  "@radix-ui/react-use-callback-ref",
  "@radix-ui/react-use-escape-keydown",
  "@radix-ui/react-use-layout-effect",
  "@radix-ui/react-direction",
  "@radix-ui/react-popper",
  "@radix-ui/react-use-size",
  "@radix-ui/react-arrow",
];
const stubFilter = new RegExp(
  "^(" +
    stubbed
      .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")(/.*)?$",
);
// Named exports commonly imported from react/react-dom/jotai/jsx-runtime.
// We emit a stub that exports each one as a no-op so named imports resolve.
// The stub is evaluated but never reached at runtime (exportToSvg doesn't
// traverse the React editor graph), so the values themselves don't matter.
const NAMED_EXPORTS = [
  // react
  "Children", "Component", "Fragment", "PureComponent", "StrictMode",
  "Suspense", "cloneElement", "createContext", "createElement", "createRef",
  "forwardRef", "isValidElement", "lazy", "memo", "useCallback", "useContext",
  "useDebugValue", "useDeferredValue", "useEffect", "useId",
  "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo",
  "useReducer", "useRef", "useState", "useSyncExternalStore",
  "useTransition", "version", "startTransition",
  // react-dom / react-dom/client
  "createPortal", "flushSync", "unstable_batchedUpdates", "createRoot",
  "hydrateRoot", "findDOMNode", "render", "unmountComponentAtNode",
  // react/jsx-runtime + jsx-dev-runtime
  "jsx", "jsxs", "jsxDEV",
  // jotai + jotai-scope + jotai internals
  "atom", "useAtom", "useAtomValue", "useSetAtom", "Provider", "createStore",
  "createIsolation", "useStore", "atomFamily", "atomWithStorage",
  "atomWithReset", "useResetAtom", "RESET",
];

// Excalidraw's index.js does static `import("./locales/xx-XX-HASH.js")` for
// every supported locale — 54 files totalling ~1.7 MB. The export path does
// not read i18n strings, so we stub the whole locales directory. the original implementation plan
const localeFilter = /(^|\/)locales\/[a-z0-9_-]+\.js$/i;

const stubPlugin = {
  name: "stub-editor-only-deps",
  setup(b) {
    b.onResolve({ filter: stubFilter }, (args) => ({
      path: args.path,
      namespace: "stub-virtual",
    }));
    b.onResolve({ filter: localeFilter }, (args) => ({
      path: args.path,
      namespace: "stub-virtual",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub-virtual" }, () => {
      // `default` is a Proxy so that patterns like `React.memo(...)`,
      // `React.forwardRef(...)`, etc. resolve to a callable no-op even for
      // names we didn't enumerate. Named imports are still listed explicitly
      // because bundlers cannot resolve wildcard re-exports from ESM stubs.
      //
      // Some callers destructure the return value of a stubbed function
      // (e.g. `const { useAtom, Provider } = createIsolation()` from jotai-
      // scope). We return a Proxy for every call, not a plain null, so that
      // destructuring always succeeds.
      const lines = [
        "// auto-generated by spike/build.mjs — editor-only dep stub.",
        "const proxy = new Proxy(function stub() { return proxy; }, {",
        "  get(_t, p) {",
        "    if (p === '__esModule') return true;",
        "    if (p === 'default') return proxy;",
        "    if (p === Symbol.toPrimitive) return () => '[stub]';",
        "    if (p === Symbol.iterator) return function*() {};",
        "    if (p === 'then') return undefined;",
        "    return proxy;",
        "  },",
        "  apply() { return proxy; },",
        "  construct() { return proxy; },",
        "});",
        "const noop = proxy;",
        "const passthrough = (c) => c;",
        "export default proxy;",
      ];
      for (const name of NAMED_EXPORTS) {
        if (name === "forwardRef" || name === "memo") {
          lines.push(`export const ${name} = passthrough;`);
        } else {
          lines.push(`export const ${name} = proxy;`);
        }
      }
      return { contents: lines.join("\n"), loader: "js" };
    });
  },
};

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(here, "entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  // `platform=neutral` defaults mainFields to [] which breaks CJS packages like
  // inherits, crc-32. We need Node-style resolution for transitive deps.
  mainFields: ["browser", "module", "main"],
  conditions: ["module", "import", "browser", "default"],
  outfile: path.join(here, "core.mjs"),
  metafile: true,
  plugins: [stubPlugin],
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.PKG_NAME": '"@excalidraw/excalidraw"',
    "import.meta.env.PKG_VERSION": '"0.18.1"',
  },
  minify,
  logLevel: "info",
});

await writeFile(
  path.join(here, "meta.json"),
  JSON.stringify(result.metafile, null, 2),
);

const bytes = result.metafile.outputs[
  path.relative(repoRoot, path.join(here, "core.mjs"))
]?.bytes;
console.log(
  `\n[spike/build] wrote spike/core.mjs (${bytes ?? "?"} bytes, minify=${minify})`,
);
if (result.warnings.length) {
  console.log(`[spike/build] warnings: ${result.warnings.length}`);
}
