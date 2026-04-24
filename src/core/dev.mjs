// Deno-only dev entry. Wired up for real in J-009.
if (typeof Deno === "undefined") {
  throw new Error("dev.mjs runs only under Deno");
}
console.error("dev.mjs: not yet implemented (see J-009)");
Deno.exit(2);
