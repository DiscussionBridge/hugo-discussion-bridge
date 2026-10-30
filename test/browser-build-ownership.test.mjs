import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const repository=fileURLToPath(new URL('../',import.meta.url));
test('normal Hugo builder preserves unknown/modified notices and refuses linked bundle targets',t=>{
  const scratch=path.join(repository,'.tmp');fs.mkdirSync(scratch,{recursive:true});
  const root=path.join(scratch,'browser-ownership-'+randomUUID());fs.mkdirSync(root);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  for(const name of ['package.json','package-lock.json','scripts/build-browser.mjs','src/browser-simple.mjs','src/browser-rich-content.mjs']) {
    const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(repository,name),file);
  }
  const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/build-browser.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:90000,env:{...process.env,DISCUSSIONBRIDGE_BUILD_RUNTIME_ROOT:repository}});
  const success=result=>{assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);};
  const output=path.join(root,'dist'),ledger=path.join(output,'browser-build-provenance.json');
  const staleName='THIRD_PARTY_LICENSES/obsolete_owned_0.0.0.txt',stale=path.join(output,staleName);
  const addStale=()=>{
    const bytes=Buffer.from('An exact previous generated notice.\n');fs.writeFileSync(stale,bytes);
    const record=JSON.parse(fs.readFileSync(ledger,'utf8'));record.bundledPackages.push({name:'obsolete-owned',version:'0.0.0',file:staleName,license:'MIT',bytes:bytes.length,sha256:hash(bytes)});fs.writeFileSync(ledger,JSON.stringify(record)+'\n');
  };
  try {
    success(run());
    const unknown=path.join(output,'THIRD_PARTY_LICENSES/operator-note.txt');fs.writeFileSync(unknown,'Keep this file.\n');
    addStale();success(run());assert.equal(fs.existsSync(stale),false);assert.equal(fs.readFileSync(unknown,'utf8'),'Keep this file.\n');
    const cleanLedger=fs.readFileSync(ledger);addStale();fs.appendFileSync(stale,'Operator edit.\n');
    const before=fs.readFileSync(ledger),bundle=path.join(output,'discussionbridge-rich-content.js'),bundleBefore=fs.readFileSync(bundle);
    const failed=run();assert.equal(failed.error,undefined,failed.error?.message);assert.notEqual(failed.status,0);assert.match(failed.stderr,/Modified previous generated notice/);assert.deepEqual(fs.readFileSync(ledger),before);assert.deepEqual(fs.readFileSync(bundle),bundleBefore);assert.match(fs.readFileSync(stale,'utf8'),/Operator edit/);
    // Restore only this test's own synthetic input before checking a separate fault.
    fs.unlinkSync(stale);fs.writeFileSync(ledger,cleanLedger);fs.unlinkSync(bundle);
    const outside=path.join(root,'must-not-be-created.js');
    try {fs.symlinkSync(outside,bundle,'file');}
    catch(error) {if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.diagnostic('Windows does not permit synthetic file symlinks; Linux CI executes this subcase.');return;}throw error;}
    const linked=run();assert.notEqual(linked.status,0);assert.match(linked.stderr,/Linked generated browser target/);assert.equal(fs.existsSync(outside),false);assert.equal(fs.lstatSync(bundle).isSymbolicLink(),true);
  } finally {
    const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(scratch));assert.ok(path.basename(resolved).startsWith('browser-ownership-'));fs.rmSync(resolved,{recursive:true});
  }
});
