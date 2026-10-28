import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Disposable workspace checks only; excluded from normal package files.
const require = createRequire(new URL("../../../hugo/package.json", import.meta.url));
const localTools = new Set(["sanitize-html", "entities"]);
export async function resolve(specifier, context, nextResolve) {
  if (localTools.has(specifier)) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  return await nextResolve(specifier, context);
}
