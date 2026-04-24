// src/core/stubs/proxy.mjs — J-010
//
// Callable-Proxy stub module. esbuild aliases editor-only packages
// (react, react-dom, jotai, jotai-scope, @excalidraw/mermaid-to-excalidraw,
// @radix-ui/*, …) and the dynamic `./locales/*.js` imports to this file so
// that `exportToSvg`'s transitive graph survives bundling without any of
// those packages actually loading at runtime.
//
// Shape (lifted verbatim from the working F-001 spike — spike/build.mjs
// virtual `stub-virtual` loader — PHASE0.md §"Finding A"):
//
// - `default` export is a callable `Proxy`. Every property access returns
//   the same Proxy (so `React.memo`, `React.forwardRef`, `jsx`, `atom`,
//   `createIsolation`, etc. all resolve to a callable no-op).
// - Calling the Proxy (`React.memo(Component)`, `createIsolation()`) returns
//   the Proxy — so destructuring the return value
//   (`const { useAtom, Provider } = createIsolation()`) still works: every
//   property off the Proxy is the Proxy.
// - Constructing it (`new SomeExport()`) returns the Proxy.
// - `__esModule: true` so interop wrappers don't double-wrap the default.
// - `Symbol.toPrimitive` returns `""` so accidental stringification is
//   harmless (`String(stub)` → `""`, `stub + "x"` → `"x"`).
// - `Symbol.iterator` yields nothing (for code that spreads an import).
// - `then` returns `undefined` so `await`ing the Proxy doesn't recursively
//   await a thenable.
//
// Every well-known named symbol (createElement, useState, jsx, atom, …) is
// re-exported as the same Proxy so that named imports statically resolve at
// bundle time. `forwardRef` and `memo` return their input (pass-through) so
// any surviving JSX call sites don't break at runtime evaluation.
//
// NOTE: The existing empty stub (`./empty.mjs`) is kept for backwards
// compatibility with any older references, but J-010's build pipes every
// stubbed module through THIS file.

const handler = {
  get(_t, prop) {
    if (prop === "__esModule") return true;
    if (prop === "default") return proxy;
    if (prop === Symbol.toPrimitive) return () => "";
    if (prop === Symbol.iterator) return function* () {};
    if (prop === "then") return undefined;
    return proxy;
  },
  apply() {
    return proxy;
  },
  construct() {
    return proxy;
  },
};

const proxy = new Proxy(function stub() {}, handler);
const passthrough = (c) => c;

export default proxy;

// React
export const Children = proxy;
export const Component = proxy;
export const Fragment = proxy;
export const PureComponent = proxy;
export const StrictMode = proxy;
export const Suspense = proxy;
export const cloneElement = proxy;
export const createContext = proxy;
export const createElement = proxy;
export const createRef = proxy;
export const forwardRef = passthrough;
export const isValidElement = proxy;
export const lazy = proxy;
export const memo = passthrough;
export const useCallback = proxy;
export const useContext = proxy;
export const useDebugValue = proxy;
export const useDeferredValue = proxy;
export const useEffect = proxy;
export const useId = proxy;
export const useImperativeHandle = proxy;
export const useInsertionEffect = proxy;
export const useLayoutEffect = proxy;
export const useMemo = proxy;
export const useReducer = proxy;
export const useRef = proxy;
export const useState = proxy;
export const useSyncExternalStore = proxy;
export const useTransition = proxy;
export const version = proxy;
export const startTransition = proxy;

// react-dom / react-dom/client
export const createPortal = proxy;
export const flushSync = proxy;
export const unstable_batchedUpdates = proxy;
export const createRoot = proxy;
export const hydrateRoot = proxy;
export const findDOMNode = proxy;
export const render = proxy;
export const unmountComponentAtNode = proxy;

// react/jsx-runtime + jsx-dev-runtime
export const jsx = proxy;
export const jsxs = proxy;
export const jsxDEV = proxy;

// jotai + jotai-scope + jotai internals
export const atom = proxy;
export const useAtom = proxy;
export const useAtomValue = proxy;
export const useSetAtom = proxy;
export const Provider = proxy;
export const createStore = proxy;
export const createIsolation = proxy;
export const useStore = proxy;
export const atomFamily = proxy;
export const atomWithStorage = proxy;
export const atomWithReset = proxy;
export const useResetAtom = proxy;
export const RESET = proxy;
