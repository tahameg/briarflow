#!/usr/bin/env node
// Enforces the dependency rule from docs/ARCHITECTURE.md §3: shared packages never import
// `node:*`, Node built-ins, Node-only packages, or React. Runs as part of `npm test`.
// Keep SHARED_PACKAGES in sync with tsconfig.shared.json.
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const SHARED_PACKAGES = ["core", "authoring", "runtime", "nodes-std", "nodes-mock", "nodes-anthropic", "client", "editor"];

/** Node-only or UI packages that shared code must never import. */
const FORBIDDEN_PACKAGES = [
  "react",
  "react-dom",
  "@xyflow/react",
  "briarflow",
  "@briarflow/storage-fs",
  "@briarflow/storage-sqlite",
  "@briarflow/python",
  "@briarflow/server",
  "@briarflow/editor-react",
  "@briarflow/testing",
];

const builtins = new Set(builtinModules.filter((m) => !m.startsWith("_")));

function reasonFor(specifier) {
  if (specifier.startsWith("node:")) return "Node built-in";
  const bare = specifier.split("/")[0];
  if (builtins.has(specifier) || builtins.has(bare)) return "Node built-in";
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) return "Node-only or UI package";
  }
  return undefined;
}

// static import/export ... from "x", side-effect import "x", dynamic import("x"), require("x")
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(c|m)?tsx?$|\.(c|m)?jsx?$/.test(entry)) yield full;
  }
}

const violations = [];

for (const pkg of SHARED_PACKAGES) {
  const pkgDir = join(root, "packages", pkg);
  if (!existsSync(pkgDir)) continue;

  const manifestPath = join(pkgDir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        const reason = reasonFor(dep);
        if (reason) violations.push(`${relative(root, manifestPath)}: ${field} lists "${dep}" (${reason})`);
      }
    }
  }

  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) continue;
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(IMPORT_RE)) {
        const specifier = match[1];
        const reason = reasonFor(specifier);
        if (reason) {
          violations.push(`${relative(root, file)}:${index + 1}: imports "${specifier}" (${reason})`);
        }
      }
    });
  }
}

// Portable entries: packages that may depend on Node-only Briarflow packages (so they are not
// "shared"), but whose src must still run on any runtime. No Node built-ins at all; the listed
// Node-only modules only through a dynamic `import()` (DECISIONS #61).
const PORTABLE_ENTRIES = [{ pkg: "server", lazyOnly: ["@hono/node-server"] }];
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;

for (const { pkg, lazyOnly } of PORTABLE_ENTRIES) {
  const srcDir = join(root, "packages", pkg, "src");
  if (!existsSync(srcDir)) continue;
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const dynamic = new Set([...line.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]));
      for (const match of line.matchAll(IMPORT_RE)) {
        const specifier = match[1];
        const where = `${relative(root, file)}:${index + 1}`;
        if (reasonFor(specifier) === "Node built-in") violations.push(`${where}: imports "${specifier}" (Node built-in in a portable entry)`);
        const lazy = lazyOnly.some((p) => specifier === p || specifier.startsWith(`${p}/`));
        if (lazy && !dynamic.has(specifier)) violations.push(`${where}: imports "${specifier}" statically (load it with await import(...))`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Dependency rule violated: shared packages must stay portable (no node:*, Node-only packages or React).");
  console.error("See docs/ARCHITECTURE.md §3. Move Node-only code to briarflow/storage-*/server, or inject it through an interface.\n");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`check-boundaries: ok (${SHARED_PACKAGES.length} shared packages, ${PORTABLE_ENTRIES.length} portable entries checked)`);
