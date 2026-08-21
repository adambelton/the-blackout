// Copies non-TS asset files (currently `.md` prompt content) from
// `src/` into `dist/` after tsc. Loaders use `import.meta.url`, which
// resolves relative to the .js file at runtime — so the .md needs to
// sit alongside the compiled .js in dist/.

import { readdirSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, join, dirname, relative } from "node:path";

const SRC = "src";
const DIST = "dist";

// `.md` files that are RUNTIME content, not documentation. We load these
// via `readFileSync(new URL(...))` so they need to live next to the
// compiled .js in dist/. `README.md` files are docs — skipped.
function isRuntimeAsset(path) {
  if (!path.endsWith(".md")) return false;
  if (basename(path) === "README.md") return false;
  return true;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (isRuntimeAsset(path)) out.push(path);
  }
  return out;
}

let copied = 0;
for (const src of walk(SRC)) {
  const dst = join(DIST, relative(SRC, src));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
}

console.log(`[copy-assets] copied ${copied} files`);
