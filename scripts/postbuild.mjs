// Runs after tsc. Marks dist/ as an ES module package so it still runs when
// copied out of the repo (see install-local.mjs), and makes the CLI executable.
import { chmodSync, writeFileSync } from "node:fs";

writeFileSync(new URL("../dist/package.json", import.meta.url), '{"type":"module"}\n');
try {
  chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
} catch { /* not supported on this filesystem; npm sets the bit on install anyway */ }
