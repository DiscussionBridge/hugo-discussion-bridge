import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const { moveSourceUrl } = await import(pathToFileURL(path.join(input.component, "src/adapter.mjs")));
const transport = (origin, permitted) => async (address, options) => {
  const url = new URL(address); if (url.origin !== permitted) throw new Error("Fixture origin mismatch");
  const response = await fetch(origin + url.pathname + url.search, options);
  return new Response(response.body, { status: response.status, headers: response.headers });
};
try {
  const result = await moveSourceUrl({ ...input.request, fetchImpl: transport(input.forum, input.request.config.serverUrl), publicFetch: transport(input.public, "https://hugo.example") });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message, native_helper: error.native_helper, native_process_probe: error.native_process_probe })); process.exitCode = 1;
}
