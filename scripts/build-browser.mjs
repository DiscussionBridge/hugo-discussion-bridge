import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {managedOutput} from "./managed-output.mjs";
import {bundledLicense} from "./bundled-license.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const output=path.join(root,"dist");
const provenanceFile=path.join(output,"browser-build-provenance.json");
for(const directory of [output,path.join(output,"THIRD_PARTY_LICENSES")]) managedOutput(root,directory,"directory");
for(const file of [provenanceFile,
  path.join(output,"browser-build-lock.json"),path.join(output,"discussionbridge-simple.js"),path.join(output,"discussionbridge-rich-content.js")]) {
  managedOutput(root,file);
}
const digest=bytes=>({bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
const previous=fs.existsSync(provenanceFile)?JSON.parse(fs.readFileSync(provenanceFile,"utf8")).bundledPackages:[];
if(!Array.isArray(previous)||new Set(previous.map(item=>item.file)).size!==previous.length) throw new Error("Invalid previous generated notice ledger");
const previousNotice=item=>{
  if(!/^THIRD_PARTY_LICENSES\/[A-Za-z0-9_.-]+\.txt$/.test(item.file)) throw new Error("Unsafe generated notice path");
  const file=path.join(output,item.file);
  const stat=managedOutput(root,file);
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
const simple=await build({ absWorkingDir:root, entryPoints: [path.join(root,"src/browser-simple.mjs")], nodePaths, bundle: true, format: "iife", minify: true, outfile: "dist/discussionbridge-simple.js", write:false, metafile:true });
const rich=await build({ absWorkingDir:root, entryPoints: [path.join(root,"src/browser-rich-content.mjs")], nodePaths, bundle: true, format: "iife", minify: true, target: ["es2022"], outfile: "dist/discussionbridge-rich-content.js", write:false, legalComments: "none", metafile:true, plugins: [{ name: "selected-math-styles", setup(builder) { builder.onLoad({ filter: /katex\.min\.css$/ }, () => ({ contents: mathCss.outputFiles[0].text, loader: "text" })); } }] });
if(simple.outputFiles.length!==1||rich.outputFiles.length!==1||path.resolve(simple.outputFiles[0].path)!==path.join(output,"discussionbridge-simple.js")||path.resolve(rich.outputFiles[0].path)!==path.join(output,"discussionbridge-rich-content.js")) throw new Error("Unexpected generated browser outputs");
const notices=new Map();
const stagedNotices=new Map();
for(const input of new Set([...Object.keys(simple.metafile.inputs),...Object.keys(rich.metafile.inputs)])) {
  let directory=path.dirname(path.resolve(root,input));
  while(directory!==path.dirname(directory)) {
    const manifest=path.join(directory,"package.json");
    if(fs.existsSync(manifest)) {
      const metadata=JSON.parse(fs.readFileSync(manifest,"utf8"));
      if(directory!==path.resolve(root)&&typeof metadata.name==="string"&&typeof metadata.version==="string") {
        const key=`${metadata.name}@${metadata.version}`;
        if(!notices.has(key)) {
          const license=bundledLicense(directory,metadata);
          const name=`THIRD_PARTY_LICENSES/${key.replace(/[^a-zA-Z0-9_.-]/g,"_")}.txt`;
          const target=path.join(output,name);
          if(stagedNotices.has(target)) throw new Error("Colliding generated license names");
          const stat=managedOutput(root,target);
          if(stat&&!previous.some(item=>item.file===name)&&!fs.readFileSync(target).equals(license.bytes)) throw new Error(`Unowned generated notice; preserve it: ${name}`);
          stagedNotices.set(target,license.bytes);
          notices.set(key,{name:metadata.name,version:metadata.version,license:metadata.license,file:name,...digest(license.bytes),licenseSource:license.licenseSource});
        }
      }
      break;
    }
    directory=path.dirname(directory);
  }
}
const inputs=["package-lock.json","scripts/build-browser.mjs","scripts/bundled-license.mjs","scripts/managed-output.mjs","src/browser-simple.mjs","src/browser-rich-content.mjs"];
const inputRecords=Object.fromEntries(inputs.map(name=>[name,digest(fs.readFileSync(path.join(root,name)))]));
const lockBytes=fs.readFileSync(path.join(root,"package-lock.json"));
// All notices, source inputs and destinations are checked before any output.
fs.mkdirSync(path.join(output,"THIRD_PARTY_LICENSES"),{recursive:true});
for(const file of [...simple.outputFiles,...rich.outputFiles]) fs.writeFileSync(file.path,file.contents);
for(const [file,bytes] of stagedNotices) fs.writeFileSync(file,bytes);
const current=new Set([...notices.values()].map(item=>item.file));
for(const item of previous) if(!current.has(item.file)) { const file=previousNotice(item);if(file)fs.unlinkSync(file); }
// npm intentionally omits package-lock.json from a packed dependency. Retain an
// inert byte-exact build receipt, not a consumer npm-shrinkwrap/install rule.
fs.writeFileSync(path.join(output,"browser-build-lock.json"),lockBytes);
fs.writeFileSync(provenanceFile,JSON.stringify({format:1,build:"npm ci && npm run build",
  packaged_lock_file:"browser-build-lock.json",
  inputs:inputRecords,
  outputs:Object.fromEntries(["discussionbridge-simple.js","discussionbridge-rich-content.js"].map(name=>[name,digest(fs.readFileSync(path.join(output,name)))])),
  bundledPackages:[...notices.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value),
},null,2)+"\n");
