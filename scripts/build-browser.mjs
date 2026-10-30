import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const output=path.join(root,"dist");
const provenanceFile=path.join(output,"browser-build-provenance.json");
for(const file of [output,path.join(output,"THIRD_PARTY_LICENSES"),provenanceFile,
  path.join(output,"browser-build-lock.json"),path.join(output,"discussionbridge-simple.js"),path.join(output,"discussionbridge-rich-content.js")]) {
  if(fs.lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error("Linked generated browser target");
}
const digest=bytes=>({bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
const previous=fs.existsSync(provenanceFile)?JSON.parse(fs.readFileSync(provenanceFile,"utf8")).bundledPackages:[];
const previousNotice=item=>{
  if(!/^THIRD_PARTY_LICENSES\/[A-Za-z0-9_.-]+\.txt$/.test(item.file)) throw new Error("Unsafe generated notice path");
  const file=path.join(output,item.file);
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat) return null;
  if(!stat.isFile()||stat.isSymbolicLink()) throw new Error("Linked/non-file previous generated notice");
  const actual=digest(fs.readFileSync(file));
  if(actual.bytes!==item.bytes||actual.sha256!==item.sha256) throw new Error("Modified previous generated notice; preserve and reconcile it");
  return file;
};
for(const item of previous) previousNotice(item);

// Optional local tool reuse does not package the tool tree or previous source.
const runtimeRoot = process.env.DISCUSSIONBRIDGE_BUILD_RUNTIME_ROOT;
const require = createRequire(runtimeRoot ? path.join(path.resolve(runtimeRoot), "package.json") : import.meta.url);
const { build } = require("esbuild");
const nodePaths = runtimeRoot ? [path.join(path.resolve(runtimeRoot), "node_modules")] : [];
const mathCss = await build({ absWorkingDir:root, entryPoints: [require.resolve("katex/dist/katex.min.css")], bundle: true, minify: true, write: false, loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" } });
const simple=await build({ absWorkingDir:root, entryPoints: ["src/browser-simple.mjs"], nodePaths, bundle: true, format: "iife", minify: true, outfile: "dist/discussionbridge-simple.js", metafile:true });
const rich=await build({ absWorkingDir:root, entryPoints: ["src/browser-rich-content.mjs"], nodePaths, bundle: true, format: "iife", minify: true, target: ["es2022"], outfile: "dist/discussionbridge-rich-content.js", legalComments: "none", metafile:true, plugins: [{ name: "selected-math-styles", setup(builder) { builder.onLoad({ filter: /katex\.min\.css$/ }, () => ({ contents: mathCss.outputFiles[0].text, loader: "text" })); } }] });
const notices=new Map();
for(const input of new Set([...Object.keys(simple.metafile.inputs),...Object.keys(rich.metafile.inputs)])) {
  let directory=path.dirname(path.resolve(root,input));
  while(directory!==path.dirname(directory)) {
    const manifest=path.join(directory,"package.json");
    if(fs.existsSync(manifest)) {
      const metadata=JSON.parse(fs.readFileSync(manifest,"utf8"));
      if(directory!==path.resolve(root)&&typeof metadata.name==="string"&&typeof metadata.version==="string") {
        const key=`${metadata.name}@${metadata.version}`;
        if(!notices.has(key)) {
          const license=fs.readdirSync(directory).find(name=>/^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
          const text=license?fs.readFileSync(path.join(directory,license),"utf8"):`License declared by package: ${JSON.stringify(metadata.license)}\nSource: ${JSON.stringify(metadata.repository)}\n`;
          const name=`THIRD_PARTY_LICENSES/${key.replace(/[^a-zA-Z0-9_.-]/g,"_")}.txt`;
          const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});
          if(fs.lstatSync(target,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error("Linked generated license notice");
          fs.writeFileSync(target,text);
          notices.set(key,{name:metadata.name,version:metadata.version,license:metadata.license,file:name,...digest(fs.readFileSync(target))});
        }
      }
      break;
    }
    directory=path.dirname(directory);
  }
}
const current=new Set([...notices.values()].map(item=>item.file));
for(const item of previous) if(!current.has(item.file)) { const file=previousNotice(item);if(file)fs.unlinkSync(file); }
const inputs=["package-lock.json","scripts/build-browser.mjs","src/browser-simple.mjs","src/browser-rich-content.mjs"];
// npm intentionally omits package-lock.json from a packed dependency. Retain an
// inert byte-exact build receipt, not a consumer npm-shrinkwrap/install rule.
fs.writeFileSync(path.join(output,"browser-build-lock.json"),fs.readFileSync(path.join(root,"package-lock.json")));
fs.writeFileSync(provenanceFile,JSON.stringify({format:1,build:"npm ci && npm run build",
  packaged_lock_file:"browser-build-lock.json",
  inputs:Object.fromEntries(inputs.map(name=>[name,digest(fs.readFileSync(path.join(root,name)))])),
  outputs:Object.fromEntries(["discussionbridge-simple.js","discussionbridge-rich-content.js"].map(name=>[name,digest(fs.readFileSync(path.join(output,name)))])),
  bundledPackages:[...notices.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value),
},null,2)+"\n");
