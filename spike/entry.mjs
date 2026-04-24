// spike/entry.mjs — the bundle entry for F-001.
// Installs shims, imports exportToSvg, exposes globalThis.__render.

import "./shims.mjs";
import { exportToSvg } from "@excalidraw/excalidraw";

globalThis.__render = async (sceneJsonString) => {
  const scene =
    typeof sceneJsonString === "string"
      ? JSON.parse(sceneJsonString)
      : sceneJsonString;
  const svgEl = await exportToSvg(
    {
      elements: scene.elements,
      appState: scene.appState || {},
      files: scene.files || {},
    },
    { skipInliningFonts: true },
  );
  return { svg: svgEl.outerHTML };
};
