// Read-only check of a normal extracted/installed npm package, before SDK use.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
if(process.argv.length!==3) throw new Error('Usage: node scripts/check-package.mjs <package-root>');
const root=path.resolve(process.argv[2]);
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9_./-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(part=>['','.','..'].includes(part));
const read=name=>{
  if(!safe(name)) throw new Error('Unsafe package member');
  let current=root;
  for(const part of name.split('/')) {current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked package member');}
  if(!fs.lstatSync(current).isFile()) throw new Error('Non-file package member');
  return fs.readFileSync(current);
};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(name,identity)=>{const bytes=read(name);if(bytes.length!==identity.bytes||digest(bytes)!==identity.sha256) throw new Error(`Package byte mismatch: ${name}`);};
const metadata=JSON.parse(read('package.json'));
if(metadata.name!=='hugo-discussion-bridge'||metadata.version!=='0.4.0-alpha.1'||metadata.engines.node!=='>=22.12.0') throw new Error('Unexpected normal package/runtime requirement');
const fixed={
  'cms-runtime.mjs':'acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076',
  'cms-schema.json':'e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0',
  'idna/DEPENDENCIES.json':'2f2a7bce6697e9ed73d2dacd29e244467e3162066d012b7801939032d0847d1e',
  'idna/LICENSES.txt':'21fed045273e053184af7f129c5eccd3d24529b04540c2494c8eb5254d46f331',
};
for(const [name,hash] of Object.entries(fixed)) if(digest(read('src/protocol-v4/'+name))!==hash) throw new Error(`Wrong frozen shared member: ${name}`);
const provenance=JSON.parse(read('src/protocol-v4/PROVENANCE.json'));
if(provenance.source.commit!=='b90348f9f010ff58fbe52237eda3187c926334ec'||provenance.candidate_id!=='discussionbridge-v4-core-20261029-r7'||provenance.release_version!==null) throw new Error('Wrong shared-source pairing');
for(const member of provenance.members) check('src/protocol-v4/'+member.path,member);
const browser=JSON.parse(read('dist/browser-build-provenance.json'));
if(browser.packaged_lock_file!=='browser-build-lock.json') throw new Error('Missing inert browser build-lock receipt');
for(const [name,identity] of Object.entries(browser.inputs)) check(name==='package-lock.json'?'dist/browser-build-lock.json':name,identity);
const outputs=['discussionbridge-simple.js','discussionbridge-rich-content.js'];
if(JSON.stringify(Object.keys(browser.outputs).sort())!==JSON.stringify([...outputs].sort())) throw new Error('Missing/unexpected bundled browser output');
for(const name of outputs) check('dist/'+name,browser.outputs[name]);
if(!Array.isArray(browser.bundledPackages)||browser.bundledPackages.length===0) throw new Error('Missing browser notices');
for(const [name,version] of [['dompurify','3.4.17'],['katex','0.18.2'],['mermaid','11.17.2']]) {
  const entries=browser.bundledPackages.filter(item=>item.name===name);
  if(entries.length!==1||entries[0].version!==version) throw new Error('Unexpected browser dependency identity');
}
const expected=new Set(['browser-build-provenance.json','browser-build-lock.json',...outputs]);
for(const notice of browser.bundledPackages) {
  if(expected.has(notice.file)) throw new Error('Repeated browser package notice');
  expected.add(notice.file);check('dist/'+notice.file,notice);
}
const census=(base,prefix='')=>fs.readdirSync(base).flatMap(name=>{
  const file=path.join(base,name),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()) throw new Error('Linked generated browser member');
  if(stat.isDirectory()) return census(file,prefix+name+'/');
  if(!stat.isFile()) throw new Error('Non-file generated browser member');
  return [prefix+name];
});
const actual=census(path.join(root,'dist'));
if(actual.length!==expected.size||actual.some(name=>!expected.has(name))) throw new Error('Unrecorded generated browser member in package');
console.log(JSON.stringify({package:metadata.name,version:metadata.version,shared_members:Object.keys(fixed).length,browser_members:actual.length,notices:browser.bundledPackages.length,read_only:true}));
