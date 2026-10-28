import path from "node:path";
import { createRequire } from "node:module";

// Optional local tool reuse does not package the tool tree or previous source.
const runtimeRoot = process.env.DISCUSSIONBRIDGE_BUILD_RUNTIME_ROOT;
const require = createRequire(runtimeRoot ? path.join(path.resolve(runtimeRoot), "package.json") : import.meta.url);
const { build } = require("esbuild");
const nodePaths = runtimeRoot ? [path.join(path.resolve(runtimeRoot), "node_modules")] : [];
const mathCss = await build({ entryPoints: [require.resolve("katex/dist/katex.min.css")], bundle: true, minify: true, write: false, loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" } });
await build({ entryPoints: ["src/browser-simple.mjs"], nodePaths, bundle: true, format: "iife", minify: true, outfile: "dist/discussionbridge-simple.js" });
await build({ entryPoints: ["src/browser-rich-content.mjs"], nodePaths, bundle: true, format: "iife", minify: true, target: ["es2022"], outfile: "dist/discussionbridge-rich-content.js", legalComments: "none", plugins: [{ name: "selected-math-styles", setup(builder) { builder.onLoad({ filter: /katex\.min\.css$/ }, () => ({ contents: mathCss.outputFiles[0].text, loader: "text" })); } }] });
