import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve declared dependencies from this checkout, never an old worktree.
// This test-only hook is excluded from normal package files.
const require = createRequire(import.meta.url);
const localTools = new Set(["sanitize-html", "entities"]);
export async function resolve(specifier, context, nextResolve) {
  if (localTools.has(specifier)) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  return await nextResolve(specifier, context);
}
