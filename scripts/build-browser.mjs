import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mathCss = await build({ entryPoints: [require.resolve("katex/dist/katex.min.css")], bundle: true, minify: true, write: false, loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" } });

await build({ entryPoints: ["src/browser-simple.mjs"], bundle: true, format: "iife", minify: true, outfile: "dist/discussionbridge-simple.js" });
await build({ entryPoints: ["src/browser-rich-content.mjs"], bundle: true, format: "iife", minify: true, target: ["es2022"], outfile: "dist/discussionbridge-rich-content.js", legalComments: "none", plugins: [{ name: "selected-math-styles", setup(builder) { builder.onLoad({ filter: /katex\.min\.css$/ }, () => ({ contents: mathCss.outputFiles[0].text, loader: "text" })); } }] });
