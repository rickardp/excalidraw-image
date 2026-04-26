// SVG golden regression gate (D-004).
// Goldens regeneration: node src/scripts/regen-goldens.mjs  (or: make goldens)
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const fixturesDir = resolve("tests/fixtures");

beforeAll(async () => {
  globalThis.location ??= { href: "http://localhost/", origin: "http://localhost" };
  await import(resolve("dist/core.mjs"));
});

const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith(".excalidraw"));

describe("SVG goldens", () => {
  for (const f of fixtures) {
    it(`${f} matches its golden`, async () => {
      const sceneJson = readFileSync(resolve(fixturesDir, f), "utf8");
      const { svg } = await globalThis.__render(sceneJson);
      const golden = readFileSync(
        resolve(fixturesDir, f.replace(/\.excalidraw$/, ".svg.golden")),
        "utf8",
      );
      if (svg !== golden) {
        const head = (s) => s.slice(0, 200).replace(/\n/g, "\\n");
        throw new Error(
          `golden mismatch for ${f}\n` +
          `  golden head: ${head(golden)}\n` +
          `  actual head: ${head(svg)}\n` +
          `  golden size: ${golden.length}, actual: ${svg.length}\n` +
          `  regenerate via: node src/scripts/regen-goldens.mjs`,
        );
      }
      expect(svg).toEqual(golden);
    });
  }
});
