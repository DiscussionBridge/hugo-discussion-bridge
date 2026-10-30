import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {bundledLicense} from '../scripts/bundled-license.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
const inputs=['package.json','package-lock.json','scripts/build-browser.mjs','scripts/bundled-license.mjs','scripts/managed-output.mjs','src/browser-simple.mjs','src/browser-rich-content.mjs'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent=fs.mkdtempSync(path.join(tmpdir(),'hugo-build-guard-'));
  const root=path.join(parent,'component');
  for(const name of inputs) {const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(repository,name),file);}
  return {parent,root};
}
function cleanup(parent) {
  const actual=fs.realpathSync(parent);
  assert.equal(path.dirname(actual),fs.realpathSync(tmpdir()));
  assert.ok(path.basename(actual).startsWith('hugo-build-guard-'));
  fs.rmSync(actual,{recursive:true});
}
function snapshot(parent) {
  const rows=[];
  function walk(at,prefix='') {
    for(const name of fs.readdirSync(at).sort()) {
      const file=path.join(at,name),key=path.join(prefix,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())rows.push([key,'link',fs.readlinkSync(file)]);
      else if(stat.isDirectory()){rows.push([key,'directory']);walk(file,key);}
      else rows.push([key,'file',hash(fs.readFileSync(file))]);
    }
  }
  walk(parent);return rows;
}
const run=root=>spawnSync(process.execPath,[path.join(root,'scripts/build-browser.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:90000,env:{...process.env,DISCUSSIONBRIDGE_BUILD_RUNTIME_ROOT:repository}});

for(const [relative,kind] of [
  ['dist','directory'],['dist/THIRD_PARTY_LICENSES','directory'],
  ['dist/discussionbridge-simple.js','file'],['dist/discussionbridge-rich-content.js','file'],
  ['dist/browser-build-provenance.json','file'],['dist/browser-build-lock.json','file'],
])for(const live of [true,false])test(`builder refuses ${live?'live':'dangling'} ${relative} before any write`,t=>{
  const {parent,root}=fixture();
  try {
    const outside=path.join(parent,'outside');
    if(live){if(kind==='directory'){fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel'),'preserve');}else fs.writeFileSync(outside,'preserve');}
    const link=path.join(root,relative);fs.mkdirSync(path.dirname(link),{recursive:true});
    try{fs.symlinkSync(outside,link,kind==='directory'&&process.platform==='win32'?'junction':kind==='directory'?'dir':'file');}
    catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file-link privilege unavailable; Linux CI must execute this case');return;}throw error;}
    const before=snapshot(parent),result=run(root);
    assert.equal(result.error,undefined,result.error?.message);assert.notEqual(result.status,0);
    assert.match(result.stderr,/Invalid or linked managed output/);assert.deepEqual(snapshot(parent),before);
  }finally{cleanup(parent);}
});

test('unowned notice collision cannot partially replace either browser bundle',()=>{
  const {parent,root}=fixture();
  try{
    fs.mkdirSync(path.join(root,'dist/THIRD_PARTY_LICENSES'),{recursive:true});
    for(const name of ['discussionbridge-simple.js','discussionbridge-rich-content.js'])fs.writeFileSync(path.join(root,'dist',name),'Keep earlier output\n');
    fs.writeFileSync(path.join(root,'dist/THIRD_PARTY_LICENSES/fastdom_1.0.12.txt'),'Operator file\n');
    const before=snapshot(parent),result=run(root);
    assert.equal(result.error,undefined,result.error?.message);assert.notEqual(result.status,0);
    assert.match(result.stderr,/Unowned generated notice/);assert.deepEqual(snapshot(parent),before);
  }finally{cleanup(parent);}
});

test('required FastDom terms are actual pinned source, never a metadata fallback',()=>{
  const parent=fs.mkdtempSync(path.join(tmpdir(),'hugo-build-guard-'));
  try{
    const readme=path.join(parent,'README.md');fs.copyFileSync(path.join(repository,'node_modules/fastdom/README.md'),readme);
    const metadata={name:'fastdom',version:'1.0.12',license:'MIT'};
    assert.equal(hash(bundledLicense(parent,metadata).bytes),'df2ae14f12f31864acef768195afe4584b08a257f25925f49884619279f02f37');
    assert.throws(()=>bundledLicense(parent,{...metadata,name:'unknown-license-package'}),/Required bundled license unavailable/);
    fs.appendFileSync(readme,'changed');assert.throws(()=>bundledLicense(parent,metadata),/Unexpected FastDom README/);
    fs.unlinkSync(readme);assert.throws(()=>bundledLicense(parent,metadata),/ENOENT/);
  }finally{cleanup(parent);}
});
