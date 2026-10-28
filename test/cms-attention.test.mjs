import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectHugoAttention, pollHugoAttention, handoffHugoAttention, restoreHugoAttentionBaseline } from "../src/cms-attention.mjs";
import { withCmsJournalObservation, withCmsJournal } from "../src/cms-journal.mjs";
import { ownedNativeFragment } from "../src/cms-proof.mjs";
import { hashCmsOwnershipReceipt } from "../src/cms-ownership.mjs";
import { validateCms, semanticIdentity } from "../src/protocol-v4/cms-runtime.mjs";
import { runHugoAttention } from "../src/cms-native.mjs";
import { withCmsContinuation } from "../src/cms-continuation.mjs";
import { connection, mappingId, work, cmsConfig, nativeOrigin, leaseToken } from "../test-support/cms-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const parent = path.resolve("C:/CodeProjects/Products/DiscussionBridge/planning/v4-attention-recovery-fixes-20261025/hugo-fixtures");
async function fixture(t) {
  const root = path.join(parent, randomUUID()), config = { siteRoot: path.join(root, "site"), privateRoot: path.join(root, "private"), siteUrl: nativeOrigin,
    contentRoot: path.join(root, "site", "content"), dataRoot: path.join(root, "site", "data"), publicRoot: path.join(root, "site", "public") };
  const journalRoot = path.join(config.privateRoot, "journals"), baselineId = randomUUID(), transactionId = randomUUID(), failedId = randomUUID(), oldId = randomUUID();
  for (const dir of [config.contentRoot, config.dataRoot, config.publicRoot, journalRoot]) await mkdir(dir, { recursive: true });
  t.after(async () => { assert.equal(path.dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  const receipt = { schema_version: "db-native-ownership-1", forum_origin: cmsConfig.serverUrl, connection_id: cmsConfig.connectionId, mapping_id: mappingId,
    resource_id: "22222222-2222-4222-8222-222222222222", source_id: "source-a", external_id: "hugo-source-a", native_id: "content/source.md", canonical_url: nativeOrigin+"/source/",
    source_revision: "revision-1", last_lease_generation: 1, move_id: null, proof_nonce: null };
  const representation = { kind: "full", source_content_sha256: hash("source original") };
  const nativeResult = { kind: "publish_revision", native_id: receipt.native_id, external_id: receipt.external_id, canonical_url: receipt.canonical_url,
    native_revision: "revision-1", ownership_receipt_sha256: hashCmsOwnershipReceipt(receipt), representation };
  const html = Buffer.from(`<!doctype html><!--discussionbridge-cms-start:${mappingId}--><section data-discussionbridge-cms-resource-id="${receipt.resource_id}" data-discussionbridge-cms-native-id="${receipt.native_id}" data-discussionbridge-cms-source-revision="revision-1" data-discussionbridge-cms-presentation="interactive"><article>baseline article</article><div class="discussionbridge-from"><div id="discourse-comments"></div></div></section><!--discussionbridge-cms-end:${mappingId}-->`);
  const fragment = ownedNativeFragment(html, { mappingId, resourceId: receipt.resource_id, nativeId: receipt.native_id, sourceRevision: "revision-1", presentationMode: "interactive" });
  const verification = { kind: "published", url: receipt.canonical_url, native_id: receipt.native_id, source_revision: "revision-1", source_content_sha256: representation.source_content_sha256,
    native_publication_sha256: fragment.sha256, verification_profile: "hugo-cms-owned-fragment-1", checked_at: "2026-10-25T00:00:00.000Z", representation };
  const mapping = { mapping_id: mappingId, resource_id: receipt.resource_id, connection_id: cmsConfig.connectionId, source_id: receipt.source_id,
    external_id: receipt.external_id, canonical_url: receipt.canonical_url, mapping_revision: "map-2", destination_native_id: receipt.native_id, retired_url_count: 0,
    mapping_state: "attention", presentation_mode: "interactive", desired_source_revision: "revision-2", synchronized_source_revision: "revision-2",
    publicly_verified_source_revision: "revision-1", destination_native_revision: "revision-2", source_created_at: null, source_updated_at: null,
    synchronized_at: "2026-10-25T01:00:00.000Z", publicly_verified_at: verification.checked_at };
  const files = [], verifiedFiles = [];
  for (const [index, name] of ["content/source.md", "data/source.json"].entries()) {
    const before = Buffer.from(`baseline ${index}`), after = Buffer.from(`candidate ${index}`);
    const beforePath = `.payloads/${mappingId}/${transactionId}/${index}-before.bin`, afterPath = `.payloads/${mappingId}/${transactionId}/${index}-after.bin`;
    const verifiedPath = `.payloads/${mappingId}/${baselineId}/${index}-after.bin`;
    for (const [file, bytes] of [[beforePath,before],[afterPath,after],[verifiedPath,before]]) { const full=path.join(journalRoot,file); await mkdir(path.dirname(full),{recursive:true}); await writeFile(full,bytes); }
    await writeFile(path.join(config.siteRoot,name),before);
    files.push({path:name,before_payload:beforePath,before_sha256:hash(before),before_bytes:before.length,after_payload:afterPath,after_sha256:hash(after),after_bytes:after.length});
    verifiedFiles.push({path:name,before_payload:null,before_sha256:null,before_bytes:null,after_payload:verifiedPath,after_sha256:hash(before),after_bytes:before.length});
  }
  const oldAuthority = { work_id:oldId,lease_generation:1,source_revision:"revision-1",policy_revision:"policy-1" };
  const authority = { work_id:failedId,lease_generation:2,source_revision:"revision-2",policy_revision:"policy-1" };
  const baseline = { transaction_id:baselineId,action:"publish_revision",authority:oldAuthority,receipt,phase:"verified",receiver_prepared:true,prepared_at:"2026-10-25T00:00:00.000Z",files:verifiedFiles,
    native_result:nativeResult,finalize_report:{verification},finalize_receiver_receipt:{mapping:{presentation_mode:"interactive"}} };
  const txReceipt={...receipt,source_revision:"revision-2",last_lease_generation:2};
  const txNative={...nativeResult,native_revision:"revision-2",ownership_receipt_sha256:hashCmsOwnershipReceipt(txReceipt)};
  const state={schema_version:"db-hugo-cms-journal-2",mapping_id:mappingId,last_lease_generation:2,authority,transaction:{transaction_id:transactionId,action:"publish_revision",authority,receipt:txReceipt,
    phase:"attention",receiver_prepared:true,prior_verified:baseline,files,native_result:txNative,prepared_at:"2026-10-25T01:00:00.000Z"},last_verified:baseline,pending_mutation:null};
  const journalFile=path.join(journalRoot,`${mappingId}.json`); await writeFile(journalFile,JSON.stringify(state)+"\n");
  await mkdir(path.join(config.publicRoot,"source")); await writeFile(path.join(config.publicRoot,"source","index.html"),html);
  const failed={...work(),work_id:failedId,source_revision:"revision-2",state:"attention",lease_generation:2,attempt:3,last_failure_code:"public_verification_failed"};
  const source={source_id:"source-a",source_revision:"revision-2",topic_id:"53",topic_url:cmsConfig.serverUrl+"/t/source/53",title:"source",content_sha256:representation.source_content_sha256,content_bytes:15,
    source_created_at:null,source_updated_at:null,source_authors:[]};
  const inspection={sequence:1,inspection_id:randomUUID(),context_sha256:hash("context"),work:failed,mapping,source,native_result:txNative,verified_native_result:nativeResult,verification,
    prepared_transaction:{transaction_id:transactionId,work_id:failedId,lease_generation:2,action:"publish_revision",source_revision:"revision-2",policy_revision:"policy-1",native_result:txNative,
      prepared_at:"2026-10-25T01:00:00.000Z",deployment_id:null,deployed_at:null},created_at:"2026-10-25T01:00:00.000Z"};
  validateCms("AttentionInspection",inspection);
  const records=new Map(),continuation={snapshot:()=>({pending:null}),async nativeRecord(name,value){if(value!==undefined)records.set(name,structuredClone(value));return structuredClone(records.get(name)??null);}};
  const publicFetch=async()=>new Response(html,{headers:{"content-type":"text/html"}});
  return {root,config,journalRoot,journalFile,state,files,inspection,records,continuation,publicFetch,connection:connection(),transactionId};
}

async function withdrawnFixture(t, { prepared = true } = {}) {
  const f = await fixture(t), baseline = f.state.last_verified;
  // Retain the real old payloads/identity, with a verified withdrawal's exact
  // absent after-manifest and a fresh public absence observation.
  baseline.action = "withdraw"; baseline.authority.source_revision = null; baseline.receipt.source_revision = null;
  baseline.native_result = { kind: "withdraw", native_id: baseline.receipt.native_id, external_id: baseline.receipt.external_id,
    canonical_url: baseline.receipt.canonical_url, native_revision: null, ownership_receipt_sha256: hashCmsOwnershipReceipt(baseline.receipt) };
  baseline.files = baseline.files.map((file) => ({ path: file.path, before_payload: file.after_payload, before_sha256: file.after_sha256,
    before_bytes: file.after_bytes, after_payload: null, after_sha256: null, after_bytes: null }));
  const absence = { kind: "absent", url: baseline.receipt.canonical_url, native_id: baseline.receipt.native_id,
    checked_at: "2026-10-25T00:00:00.000Z", http_status: 404 };
  baseline.finalize_report = { verification: absence };
  for (const file of f.files) {
    const native = path.resolve(f.config.siteRoot, file.path);
    assert.ok(path.relative(f.config.siteRoot, native) && !path.relative(f.config.siteRoot, native).startsWith(".."));
    await rm(native);
    file.before_payload = null; file.before_sha256 = null; file.before_bytes = null;
  }
  f.inspection.verified_native_result = baseline.native_result; f.inspection.verification = absence;
  f.inspection.mapping.publicly_verified_source_revision = null;
  if (!prepared) {
    f.state.transaction = structuredClone(baseline); f.inspection.prepared_transaction = null;
    f.inspection.native_result = baseline.native_result; f.inspection.mapping.synchronized_source_revision = null;
    f.inspection.mapping.destination_native_revision = null;
  }
  await writeFile(f.journalFile, JSON.stringify(f.state)+"\n");
  f.publicFetch = async () => new Response(null, { status: 404 });
  validateCms("AttentionInspection", f.inspection);
  return f;
}

test("Hugo Check proves restored baseline without altering old journal/content/command state",async(t)=>{
  const f=await fixture(t), before=await readFile(f.journalFile);
  const result=await collectHugoAttention(f);
  assert.equal(result.native_state,"restored_baseline"); assert.equal(result.issue,"none"); assert.equal(result.source_revision,"revision-1");
  assert.equal(result.verification.kind,"published"); assert.ok(result.journal_sha256); assert.deepEqual(await readFile(f.journalFile),before);
  assert.equal(result.current_sha256,result.baseline_sha256);
  assert.equal(f.records.size,0); assert.equal(await readFile(path.join(f.config.siteRoot,f.files[0].path),"utf8"),"baseline 0");
  await withCmsJournalObservation({journalRoot:f.journalRoot,nativeRoot:f.config.siteRoot,mappingId},(view)=>{assert.equal(view.restoreRecordedBaseline,undefined);assert.equal(view.archiveAndHandoff,undefined);});
});

test("Hugo Check blocks applied static candidate, partial/foreign files and uncertain command or mutation",async(t)=>{
  const f=await fixture(t);
  for(const file of f.files)await writeFile(path.join(f.config.siteRoot,file.path),await readFile(path.join(f.journalRoot,file.after_payload)));
  assert.equal((await collectHugoAttention(f)).native_state,"candidate_applied");
  await writeFile(path.join(f.config.siteRoot,f.files[0].path),"baseline 0"); assert.equal((await collectHugoAttention(f)).issue,"partial_files");
  await writeFile(path.join(f.config.siteRoot,f.files[0].path),"foreign user edit"); assert.equal((await collectHugoAttention(f)).issue,"native_conflict");
  f.records.set(`native/${f.transactionId}/deploy.json`,{transaction_id:f.transactionId,kind:"deploy",phase:"running"});
  assert.equal((await collectHugoAttention(f)).issue,"uncertain_command");
  f.continuation.snapshot=()=>({pending:{route_id:"V4-18"}}); assert.equal((await collectHugoAttention(f)).issue,"uncertain_mutation");
});

test("Hugo baseline restore is explicit, journals before replacing exact candidate and preserves failure evidence",async(t)=>{
  const f=await fixture(t),before=await readFile(f.journalFile),operationId=randomUUID();
  for(const file of f.files)await writeFile(path.join(f.config.siteRoot,file.path),await readFile(path.join(f.journalRoot,file.after_payload)));
  const restored=await restoreHugoAttentionBaseline({...f,mappingId,transactionId:f.transactionId,operationId});
  assert.equal(restored.native_restored,true);assert.equal(restored.public_restored,false);assert.deepEqual(await readFile(f.journalFile),before);
  assert.equal(await readFile(path.join(f.config.siteRoot,f.files[0].path),"utf8"),"baseline 0");
  const operation=JSON.parse(await readFile(path.join(f.journalRoot,".restorations",mappingId,`${operationId}.completed.json`),"utf8"));
  assert.equal(operation.journal_sha256,hash(before)); assert.equal(operation.restored,true);
  await restoreHugoAttentionBaseline({...f,mappingId,transactionId:f.transactionId,operationId});
  await writeFile(path.join(f.config.siteRoot,f.files[0].path),"foreign");
  await assert.rejects(restoreHugoAttentionBaseline({...f,mappingId,transactionId:f.transactionId,operationId:randomUUID()}),/foreign/);
});

test("Hugo lost report response replays same observation and stages same-source successor before cursor",async(t)=>{
  const f=await fixture(t),reports=[];let lose=true;
  const successor={...f.inspection.work,work_id:randomUUID(),attempt_cycle:randomUUID(),state:"pending",attempt:0,lease_generation:0,last_failure_code:null};
  const recovery={sequence:1,recovery_id:randomUUID(),inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,predecessor_work_id:f.inspection.work.work_id,
    predecessor_attempt_cycle:f.inspection.work.attempt_cycle,work:successor,mapping:{...f.inspection.mapping,mapping_state:"pending"},source:f.inspection.source,mode:"settle_restored_baseline",
    native_baseline:f.inspection.verified_native_result,verification:f.inspection.verification,created_at:"2026-10-25T02:00:00.000Z"};
  const client={async request(route,{query,body}={}){
    if(route==="V4-32")return{value:{protocol_revision:"attention-recovery-1",inspection_profiles:["hugo-static-1"]}};
    if(route==="V4-33")return{value:{items:query.after===0?[f.inspection]:[],next_after:1,has_more:false}};
    if(route==="V4-34"){reports.push(structuredClone(body));if(lose){lose=false;throw new Error("lost response");}return{value:{inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,status:"ready",issue:"none",observed_at:body.observation.observed_at}};}
    if(route==="V4-35")return{value:{items:[recovery],next_after:1,has_more:false}};
    assert.fail(route);
  }};
  await assert.rejects(pollHugoAttention({...f,client}),/lost response/); await pollHugoAttention({...f,client});
  assert.equal(semanticIdentity(reports[0]),semanticIdentity(reports[1]));
  assert.equal(f.records.get("native/attention/cursors.json").recoveries,1);
  assert.deepEqual(f.records.get("native/attention/queue.json").recovery_ids,[recovery.recovery_id]);
  assert.equal(f.records.get(`native/recoveries/${recovery.recovery_id}.json`).recovery.work.source_revision,f.inspection.work.source_revision);
  const lease={work:{...successor,state:"leased",attempt:1,lease_generation:3},lease_token:leaseToken,lease_generation:3,expires_at:"2026-10-25T03:05:00.000Z",server_time:"2026-10-25T03:00:00.000Z"};
  const before=await readFile(f.journalFile);let leaseChecks=0;
  await assert.rejects(handoffHugoAttention({...f,recovery,lease,assertCurrentLease:async()=>{throw new Error("lease expired");}}),/lease expired/);
  assert.deepEqual(await readFile(f.journalFile),before);
  await handoffHugoAttention({...f,recovery,lease,assertCurrentLease:async()=>{leaseChecks++;}});assert.equal(leaseChecks,2);
  const next=JSON.parse(await readFile(f.journalFile,"utf8"));assert.equal(next.last_lease_generation,2);assert.equal(next.transaction.phase,"verified");assert.equal(next.last_verified.receipt.native_id,f.inspection.mapping.destination_native_id);
  const history=JSON.parse(await readFile(path.join(f.journalRoot,".recovery",mappingId,`${f.inspection.work.work_id}.json`),"utf8"));
  assert.equal(history.journal_sha256,hash(before));assert.equal(history.journal.transaction.phase,"attention");
  await withCmsJournal({journalRoot:f.journalRoot,nativeRoot:f.config.siteRoot,mappingId},{work_id:successor.work_id,lease_generation:3,source_revision:"revision-2",policy_revision:"policy-1"},async(journal)=>assert.equal(journal.snapshot().last_lease_generation,3));
});

test("Hugo Check refuses unavailable baseline public proof and preserves private r5 creation provenance",async(t)=>{
  const f=await fixture(t),before=await readFile(f.journalFile);
  assert.equal((await collectHugoAttention({...f,publicFetch:async()=>new Response("wrong",{headers:{"content-type":"text/html"}})})).issue,"public_proof_unavailable");
  assert.deepEqual(await readFile(f.journalFile),before);
  const provenance=JSON.parse(await readFile(new URL("../src/protocol-v4/PROVENANCE-r5.json",import.meta.url),"utf8"));assert.equal(provenance.candidate_id,"discussionbridge-v4-core-20261015-r5");
});

test("selected native metadata remains unavailable rather than allowing attention recovery",async(t)=>{
  const f=await fixture(t),before=await readFile(f.journalFile),selected=structuredClone(f.connection);selected.policy.author_ids=["unmapped-native-author"];
  const result=await collectHugoAttention({...f,connection:selected});assert.equal(result.issue,"metadata_unavailable");assert.equal(result.native_state,"unknown");
  assert.deepEqual(await readFile(f.journalFile),before);assert.equal(f.records.size,0);
});

test("actual Ruby Core class accepts Hugo restored-baseline facts and rejects mismatched hash/public proof",async(t)=>{
  const f=await fixture(t),observation=await collectHugoAttention(f), file=path.join(f.root,"core-observation.json");
  const observations=[observation,{...observation,current_sha256:hash("changed")},{...observation,verification:null}];
  await writeFile(file,JSON.stringify({inspection:f.inspection,observations}));
  const ruby="C:/Users/Owner/AppData/Local/Programs/Ruby33-x64-portable/rubyinstaller-3.3.12-1-x64/bin/ruby.exe";
  const evaluator=path.resolve("../discourse-plugin/lib/discussion_bridge/cms_attention_evidence.rb");
  const script=`require 'json'; module DiscussionBridge; module CmsProtocol; def self.canonical(v); case v; when Hash; v.keys.sort.to_h{|k|[k,canonical(v[k])]}; when Array; v.map{|c|canonical(c)}; else v; end; end; def self.semantic_identity(v); JSON.generate(canonical(v)); end; end; end; require ARGV[0]; data=JSON.parse(File.read(ARGV[1])); puts JSON.generate(data.fetch('observations').map{|v|DiscussionBridge::CmsAttentionEvidence.evaluate(data.fetch('inspection'),v,profile:'hugo',publication_kind:'static')});`;
  const {stdout}=await promisify(execFile)(ruby,["-e",script,evaluator,file],{windowsHide:true});
  assert.deepEqual(JSON.parse(stdout).map((row)=>row.status),["ready","not_ready","not_ready"]);
  await writeFile(path.join(parent,"..","HUGO_CORE_OBSERVATION.json"),JSON.stringify({inspection:f.inspection,observation,core_evaluator_sha256:hash(await readFile(evaluator)),outcomes:JSON.parse(stdout)},null,2)+"\n");
});

test("Hugo exports actual collector ready/blocked cases for root cross-runtime Core integration",async(t)=>{
  const f=await fixture(t),cases=[];
  const add=async(id,expected_status,options={})=>cases.push({id,profile:"hugo",publication_kind:"static",inspection:options.inspection??f.inspection,
    observation:await collectHugoAttention({...f,...options}),expected_status});
  await add("hugo-restored-baseline","ready");
  for(const file of f.files)await writeFile(path.join(f.config.siteRoot,file.path),await readFile(path.join(f.journalRoot,file.after_payload)));
  await add("hugo-applied-static-candidate","not_ready");
  await writeFile(path.join(f.config.siteRoot,f.files[0].path),"foreign edit");await add("hugo-foreign-native","not_ready");
  f.records.set(`native/${f.transactionId}/deploy.json`,{transaction_id:f.transactionId,kind:"deploy",phase:"intent"});await add("hugo-uncertain-deploy","not_ready");
  const sourceId="source-b",freshId=randomUUID(),slug=`source-${hash(`${cmsConfig.connectionId}\0${sourceId}`)}`;
  const initial={...structuredClone(f.inspection),inspection_id:randomUUID(),prepared_transaction:null,native_result:null,verified_native_result:null,verification:null};
  Object.assign(initial.mapping,{mapping_id:freshId,resource_id:randomUUID(),source_id:sourceId,external_id:`hugo-cms:${slug.slice(7)}`,destination_native_id:null,canonical_url:nativeOrigin+`/discussionbridge/${slug}/`,synchronized_source_revision:null,publicly_verified_source_revision:null,destination_native_revision:null});
  initial.work={...initial.work,work_id:randomUUID(),mapping_id:freshId,source_id:sourceId};initial.source={...initial.source,source_id:sourceId};
  await add("hugo-never-applied-initial","ready",{inspection:initial});
  await add("hugo-uncertain-initial-mutation","not_ready",{inspection:initial,continuation:{...f.continuation,snapshot:()=>({pending:{route_id:"V4-18"}})}});
  await writeFile(path.join(parent,"..","HUGO_CORE_INTEROP.json"),JSON.stringify(cases,null,2)+"\n");
  assert.equal(cases[0].observation.current_sha256,cases[0].observation.baseline_sha256);
  assert.equal(cases.find((entry)=>entry.id==="hugo-never-applied-initial").observation.object_exists,false);
  assert.equal(cases.at(-1).observation.pending_mutation,"uncertain");
});

test("real check-only entrypoint preserves r5 writer provenance and never claims, restores or runs configured commands",async(t)=>{
  const f=await fixture(t),journal=await readFile(f.journalFile),requests=[];
  const writer=path.join(f.config.contentRoot,".discussionbridge-writer","authority.json");await mkdir(path.dirname(writer),{recursive:true});
  const prior=JSON.stringify({schema_version:"db-hugo-native-writer-1",wire_version:"v4",candidate_id:"discussionbridge-v4-core-20261015-r5",
    schema_sha256:"7dee282601e4195459f38b2f2451a5f0f03af39a5f60affc65c49b34664e3f7a",connection_id:cmsConfig.connectionId,forum_origin:cmsConfig.serverUrl,private_root:f.config.privateRoot});
  await writeFile(writer,prior);
  const cmsFetch=async(address,options)=>{
    const url=new URL(address),route=url.pathname.replace("/discussion-bridge/v4/","");requests.push(route);
    const json=(v)=>new Response(JSON.stringify(v),{headers:{"content-type":"application/json"}});
    if(route==="connection.json")return json(f.connection);
    if(route==="attention-recovery.json")return json({protocol_revision:"attention-recovery-1",candidate_id:"discussionbridge-v4-core-20261025-r6",inspection_profiles:["hugo-static-1"]});
    if(route==="attention-inspections.json")return json({items:[f.inspection],next_after:1,has_more:false});
    if(route.endsWith("/report.json")){const body=JSON.parse(options.body);assert.equal(body.observation.native_state,"restored_baseline");return json({inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,status:"ready",issue:"none",observed_at:body.observation.observed_at});}
    if(route==="work/recoveries.json")return json({items:[],next_after:0,has_more:false});
    assert.fail("Check called a publication/mutation route: "+route);
  };
  const command={executable:process.execPath,args:["-e","throw Error('Check must not run native commands')"],timeoutMs:1000};
  const native={siteRoot:f.config.siteRoot,privateRoot:f.config.privateRoot,siteUrl:f.config.siteUrl,dataDirectory:"data",nativeShortcode:"discussionbridge",build:command,deploy:command};
  const result=await runHugoAttention({native,connectionConfig:cmsConfig,cmsFetch,publicFetch:f.publicFetch});
  assert.equal(result.inspections,1);assert.equal(result.supported,true);assert.equal(await readFile(writer,"utf8"),prior);assert.deepEqual(await readFile(f.journalFile),journal);
  assert.equal(requests.some((route)=>/claim|renew|prepare|finalize|abort|fail/.test(route)),false);
});

test("actual Hugo continuation targets recovery successor and replays lost claim identity across restart",async(t)=>{
  const f=await fixture(t),successor={...f.inspection.work,work_id:randomUUID(),attempt_cycle:randomUUID(),state:"pending",attempt:0,lease_generation:0,last_failure_code:null};
  const recovery={sequence:1,recovery_id:randomUUID(),inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,predecessor_work_id:f.inspection.work.work_id,
    predecessor_attempt_cycle:f.inspection.work.attempt_cycle,work:successor,mapping:{...f.inspection.mapping,mapping_state:"pending"},source:f.inspection.source,mode:"settle_restored_baseline",
    native_baseline:f.inspection.verified_native_result,verification:f.inspection.verification,created_at:"2026-10-25T02:00:00.000Z"};
  const leased={work:{...successor,state:"leased",attempt:1,lease_generation:3},lease_token:leaseToken,lease_generation:3,expires_at:"2026-10-25T03:05:00.000Z",server_time:"2026-10-25T03:00:00.000Z"};
  let lose=true;const calls=[];
  const client={origin:cmsConfig.serverUrl,async request(route,request){calls.push({route,...structuredClone(request)});assert.equal(route,"V4-36");assert.equal(request.path.recovery_id,recovery.recovery_id);assert.equal(request.body.work_id,successor.work_id);if(lose){lose=false;throw new Error("lost targeted claim");}return{status:200,value:leased};}};
  const options={privateRoot:f.config.privateRoot,nativeRoot:f.config.siteRoot,publicRoots:[f.config.publicRoot],client,connection:f.connection};
  await assert.rejects(withCmsContinuation(options,(continuation)=>continuation.claimRecovery(recovery)),/lost targeted claim/);
  const accepted=await withCmsContinuation(options,(continuation)=>continuation.claimRecovery(recovery));assert.equal(accepted.work.work_id,successor.work_id);
  assert.equal(calls.length,2);assert.equal(semanticIdentity(calls[0]),semanticIdentity(calls[1]));
  await withCmsContinuation(options,async(continuation)=>{assert.equal((await continuation.claimRecovery(recovery)).work.work_id,successor.work_id);await continuation.releaseCompletedLease({...leased.work,state:"verified"});});
  assert.equal(calls.length,2);
});

test("Hugo previously verified withdrawal and restored withdrawal retain owned identity with proven native/public absence",async(t)=>{
  const cases=[];
  for(const prepared of [false,true]) {
    const f=await withdrawnFixture(t,{prepared}),before=await readFile(f.journalFile),observation=await collectHugoAttention(f);
    assert.equal(observation.native_state,prepared?"restored_baseline":"baseline");assert.equal(observation.issue,"none");
    assert.equal(observation.object_exists,false);assert.equal(observation.native_id,f.inspection.mapping.destination_native_id);
    assert.equal(observation.native_result.kind,"withdraw");assert.equal(observation.managed_content_sha256,null);
    assert.equal(observation.source_revision,null);assert.equal(observation.native_revision,null);
    assert.equal(observation.current_sha256,observation.baseline_sha256);assert.equal(observation.verification.kind,"absent");
    assert.equal(observation.verification.native_id,observation.native_id);assert.equal(observation.verification.url,f.inspection.mapping.canonical_url);
    assert.deepEqual(await readFile(f.journalFile),before);
    cases.push({id:prepared?"hugo-restored-verified-withdrawal":"hugo-verified-withdrawal-baseline",profile:"hugo",publication_kind:"static",inspection:f.inspection,observation,expected_status:"ready"});
  }
  await writeFile(path.join(parent,"..","HUGO_WITHDRAWN_CORE_INTEROP.json"),JSON.stringify(cases,null,2)+"\n");
});

test("Hugo withdrawn baseline refuses forged manifest, actual remaining native file, missing public absence and unknown operations",async(t)=>{
  const cases=[];
  const add=async(f,id,options={})=>{const observation=await collectHugoAttention({...f,...options});assert.notEqual(observation.issue,"none");cases.push({id,profile:"hugo",publication_kind:"static",inspection:f.inspection,observation,expected_status:"not_ready"});return observation;};
  const present=await withdrawnFixture(t);await writeFile(path.join(present.config.siteRoot,present.files[0].path),await readFile(path.join(present.journalRoot,present.files[0].after_payload)));
  await add(present,"hugo-withdrawn-native-still-present");
  const forged=await withdrawnFixture(t,{prepared:false}),base=forged.state.last_verified;
  for(const file of base.files) {
    // An action label and matching hashes of existing files do not prove absence.
    const bytes=await readFile(path.join(forged.journalRoot,file.before_payload));await writeFile(path.join(forged.config.siteRoot,file.path),bytes);
    file.after_payload=file.before_payload;file.after_sha256=file.before_sha256;file.after_bytes=file.before_bytes;
  }
  forged.state.transaction=structuredClone(base);await writeFile(forged.journalFile,JSON.stringify(forged.state)+"\n");
  assert.equal((await add(forged,"hugo-forged-withdrawn-manifest")).native_state,"conflict");
  const missing=await withdrawnFixture(t);await add(missing,"hugo-withdrawn-public-not-absent",{publicFetch:async()=>new Response("still published",{headers:{"content-type":"text/html"}})});
  const unknown=await withdrawnFixture(t);unknown.records.set(`native/${unknown.transactionId}/deploy.json`,{transaction_id:unknown.transactionId,kind:"deploy",phase:"intent"});
  assert.equal((await add(unknown,"hugo-withdrawn-unknown-command")).issue,"uncertain_command");
  const pending=await withdrawnFixture(t);assert.equal((await add(pending,"hugo-withdrawn-unknown-mutation",{continuation:{...pending.continuation,snapshot:()=>({pending:{route_id:"V4-18"}})}})).issue,"uncertain_mutation");
  const old=JSON.parse(await readFile(path.join(parent,"..","HUGO_WITHDRAWN_CORE_INTEROP.json"),"utf8"));
  await writeFile(path.join(parent,"..","HUGO_WITHDRAWN_CORE_INTEROP.json"),JSON.stringify([...old,...cases],null,2)+"\n");
});

test("Hugo verified withdrawal successor handoff preserves native identity/history and normal stage applies under higher fence",async(t)=>{
  const f=await withdrawnFixture(t),observation=await collectHugoAttention(f),successor={...f.inspection.work,work_id:randomUUID(),attempt_cycle:randomUUID(),state:"pending",attempt:0,lease_generation:0,last_failure_code:null};
  const report={mutation_id:randomUUID(),context_sha256:f.inspection.context_sha256,observation};
  f.records.set(`native/attention/${f.inspection.inspection_id}.json`,{inspection:f.inspection,report,result:{inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,status:"ready",issue:"none",observed_at:observation.observed_at}});
  const recovery={sequence:1,recovery_id:randomUUID(),inspection_id:f.inspection.inspection_id,context_sha256:f.inspection.context_sha256,predecessor_work_id:f.inspection.work.work_id,
    predecessor_attempt_cycle:f.inspection.work.attempt_cycle,work:successor,mapping:{...f.inspection.mapping,mapping_state:"pending"},source:f.inspection.source,mode:"settle_restored_baseline",
    native_baseline:f.inspection.verified_native_result,verification:observation.verification,created_at:"2026-10-25T02:00:00.000Z"};
  const lease={work:{...successor,state:"leased",attempt:1,lease_generation:3},lease_token:leaseToken,lease_generation:3,expires_at:"2026-10-25T03:05:00.000Z",server_time:"2026-10-25T03:00:00.000Z"};
  await handoffHugoAttention({...f,recovery,lease,assertCurrentLease:async()=>{}});
  const nextAuthority={work_id:successor.work_id,lease_generation:3,source_revision:successor.source_revision,policy_revision:successor.policy_revision};
  const nextReceipt={...f.state.transaction.receipt,last_lease_generation:3},transactionId=randomUUID();
  await withCmsJournal({journalRoot:f.journalRoot,nativeRoot:f.config.siteRoot,mappingId},nextAuthority,async(journal)=>{
    assert.equal(journal.snapshot().last_verified.action,"withdraw");assert.equal(journal.snapshot().last_verified.receipt.native_id,nextReceipt.native_id);
    const files=await Promise.all(f.files.map(async(file)=>({path:file.path,expectedSha256:null,bytes:await readFile(path.join(f.journalRoot,file.after_payload))})));
    await journal.stage({transactionId,action:"publish_revision",receipt:nextReceipt,files});await journal.apply(transactionId);
    assert.equal(journal.snapshot().last_lease_generation,3);assert.equal(journal.snapshot().transaction.receipt.native_id,f.inspection.mapping.destination_native_id);
    assert.equal(journal.snapshot().transaction.authority.work_id,successor.work_id);
  });
  assert.equal(await readFile(path.join(f.config.siteRoot,f.files[0].path),"utf8"),"candidate 0");
  const history=JSON.parse(await readFile(path.join(f.journalRoot,".recovery",mappingId,`${f.inspection.work.work_id}.json`),"utf8"));
  assert.equal(history.journal.transaction.phase,"attention");assert.equal(history.journal.last_verified.action,"withdraw");
  assert.equal(history.journal.last_verified.receipt.native_id,f.inspection.mapping.destination_native_id);
});
