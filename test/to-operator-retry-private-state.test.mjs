import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {connection,nativeOrigin} from '../test-support/cms-fixture.mjs';
const component=process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT?path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT):fileURLToPath(new URL('..',import.meta.url));
const {readOperationalState,writeOperationalState,stageOperatorRetry,validateOperationalState,summarizeOperationalState}=await import(pathToFileURL(path.join(component,'src/operational-state.mjs')));
const {toRecord,payloadIdentity}=await import(pathToFileURL(path.join(component,'src/to-source.mjs')));
const {parseCmsJson}=await import(pathToFileURL(path.join(component,'src/protocol-v4/cms-runtime.mjs')));
const {nativeSemanticJson}=await import(pathToFileURL(path.join(component,'src/native-state.mjs')));
const hash=b=>createHash('sha256').update(b).digest('hex');

async function fixture(t,uid=-1,gid=-1){
  const base=path.resolve(component,'.tmp/retry-private-state-tests');await mkdir(base,{recursive:true});
  const root=path.resolve(await mkdtemp(path.join(base,'owned-')));
  assert.equal(path.dirname(root),base);
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),base);assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true,force:true});});
  const file=path.join(root,'private','source.json'),state=await readOperationalState(file),correlationId=randomUUID();
  const record=toRecord({full_content_html:'<p>Unchanged full source.</p>',external_id:'article',canonical_url:`${nativeOrigin}/article/`,title:'Native article',to_created_at:null,to_updated_at:null,source_authors:[]},connection(),{correlationId});
  const pending={identity:payloadIdentity(record),request:{mutation_id:randomUUID(),bridge_record:record},native_evidence:{source_file:'article.md',source_sha256:hash('actual authored fixture bytes')}};
  const operation={externalId:record.external_id,canonicalUrl:record.canonical_url,pageKey:'article',correlationId,attempts:1,outcome:'rejected',retryable:false,reconciliationRequired:true,lastAttemptAt:'2026-10-25T12:00:00.000Z',pendingToMutation:structuredClone(pending),requestedSourceRevision:record.source_revision,requestedPreviousRevision:null,rejectedToIntent:{schema_version:'db-hugo-to-rejection-2',outcome:'rejected',pending:structuredClone(pending),receiver:{route_id:'V4-02',http_status:422,code:'invalid_field'}}};
  state.operations.article=operation;
  // Synthetic persisted audit evidence, not a live issued operator capability.
  const action={schema_version:'db-hugo-local-source-retry-action-1',action_id:randomUUID(),command:'retry-source',page_key:'article',state_path:file,config_path:path.join(root,'private','config.json'),refused_mutation_id:pending.request.mutation_id,invoked_at:'2026-10-25T12:01:00.000Z',operator:{username:'synthetic-operator',uid,gid,platform:'win32',pid:4242,executable:path.join(root,'synthetic-node.exe'),process_identity:{platform:'win32',pid:4242,start:'638960000000000000'}}};
  validateOperationalState(state);stageOperatorRetry(operation,action);await writeOperationalState(file,state);
  return {file,state,operation,action};
}

for(const [name,uid,gid]of [['Windows',-1,-1],['nonnegative control',1000,1000]])test(`actual private writer/read/status round-trip preserves ${name} retry lineage`,async t=>{
  const f=await fixture(t,uid,gid),bytes=await readFile(f.file),loaded=await readOperationalState(f.file);
  assert.equal(nativeSemanticJson(loaded),nativeSemanticJson(f.state));
  assert.equal(loaded.operations.article.toOperatorRetries[0].action.operator.uid,uid);
  assert.equal(loaded.operations.article.toOperatorRetries[0].action.operator.gid,gid);
  assert.equal(summarizeOperationalState(loaded).pending,1);
  await writeOperationalState(f.file,loaded);
  assert.deepEqual(await readFile(f.file),bytes);
});

test('private signed audit IDs do not loosen negative wire integer validation',async t=>{
  const f=await fixture(t),raw=JSON.parse(await readFile(f.file,'utf8'));
  raw.operations.article.pendingToMutation.request.bridge_record.source_content_bytes=-1;
  await writeFile(f.file,JSON.stringify(raw));
  await assert.rejects(readOperationalState(f.file),e=>e.code==='invalid_field'&&e.path==='$.bridge_record.source_content_bytes');
  assert.throws(()=>parseCmsJson(Buffer.from('{"count":-1}')),e=>e.code==='invalid_field');
});

test('actual private decoder still refuses duplicate JSON members',async t=>{
  const f=await fixture(t);await writeFile(f.file,'{"schemaVersion":1,'+(await readFile(f.file,'utf8')).trim().slice(1));
  await assert.rejects(readOperationalState(f.file),e=>e.code==='invalid_json');
});

test('actual private decoder preserves checked refusal and replacement linkage after reload',async t=>{
  const f=await fixture(t),valid=await readOperationalState(f.file),corrupt=JSON.parse(JSON.stringify(valid));
  corrupt.operations.article.toOperatorRetries[0].replacement_pending.request.bridge_record.title='Changed linked source';
  await writeFile(f.file,JSON.stringify(corrupt));
  await assert.rejects(readOperationalState(f.file),e=>e.message==='Hugo current V4 source ledger needs reconciliation.');
});

test('actual private writer keeps stale writer CAS after signed audit reload',async t=>{
  const f=await fixture(t),first=await readOperationalState(f.file),second=await readOperationalState(f.file);
  first.operations.article.lastAttemptAt='2026-10-25T12:02:00.000Z';await writeOperationalState(f.file,first);
  const written=await readFile(f.file);second.operations.article.lastAttemptAt='2026-10-25T12:03:00.000Z';
  await assert.rejects(writeOperationalState(f.file,second),e=>e.message==='Hugo current V4 source ledger needs reconciliation.');assert.deepEqual(await readFile(f.file),written);
});

test('actual private writer rejects out-of-range local audit identity',async t=>{
  const f=await fixture(t),before=await readFile(f.file);f.operation.toOperatorRetries[0].action.operator.uid=-2;
  await assert.rejects(writeOperationalState(f.file,f.state),e=>e.code==='native_ownership_conflict');assert.deepEqual(await readFile(f.file),before);
});
