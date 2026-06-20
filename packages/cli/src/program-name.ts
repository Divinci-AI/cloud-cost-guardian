import { basename } from "node:path";

/**
 * The name the user actually invoked this CLI as.
 *
 * Both `ks` and `kill-switch` are registered bins, but hints used to always
 * print `kill-switch` while most users (and the docs) run `ks` — the dogfood
 * team flagged the mismatch. Echo whichever bin was actually invoked, defaulting
 * to the short `ks` (the canonical form when we can't tell, e.g. `node dist/index.js`).
 */
function detectBinName(): string {
  const invoked = basename(process.argv[1] || "");
  return invoked === "kill-switch" ? "kill-switch" : "ks";
}

export const BIN = detectBinName();
