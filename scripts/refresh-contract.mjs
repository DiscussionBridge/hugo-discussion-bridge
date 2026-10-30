// Offline maintainer pairing; no operator-side SDK download or install step.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

if(process.argv.length!==3) throw new Error('Usage: node scripts/refresh-contract.mjs <reviewed-contract-root>');
const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.resolve(process.argv[2]);
const pins={commit:'b90348f9f010ff58fbe52237eda3187c926334ec',candidate:'discussionbridge-v4-core-20261029-r7',
  normative:'808042688cbde88fac0acdf1187e4cb8c251e13025bfcf09cf3a3c361ca02003',
  runtime:'acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076',
  schema:'e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0',
  dependencies:'2f2a7bce6697e9ed73d2dacd29e244467e3162066d012b7801939032d0847d1e',
  licenses:'21fed045273e053184af7f129c5eccd3d24529b04540c2494c8eb5254d46f331'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=(name,expected)=>{
  const file=path.join(source,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Linked/non-file shared member');
  const bytes=fs.readFileSync(file);
  if(expected&&sha(bytes)!==expected) throw new Error(`Wrong frozen shared bytes: ${name}`);
  return bytes;
};
const candidate=JSON.parse(read('CANDIDATE.json'));
if(candidate.candidate_id!==pins.candidate||candidate.implementation_version!=='0.4.0-alpha.1'||candidate.wire_version!=='v4'||candidate.release_version!==null) throw new Error('Wrong shared tuple');
const normative=read('normative/CONTRACT.json',pins.normative);
const members=[
  ['cms-runtime.mjs','src/cms-runtime.mjs',pins.runtime],
  ['cms-schema.json','src/cms-schema.json',pins.schema],
  ['idna/DEPENDENCIES.json','src/js-idna/DEPENDENCIES.json',pins.dependencies],
  ['idna/LICENSES.txt','src/js-idna/LICENSES.txt',pins.licenses],
].map(([target,name,hash])=>({target,bytes:read(name,hash)}));
const fixturePins={
  'positive-examples.json':'b3ea942e9fe6b824ab2a0af5f4eecf46b672d544856fea53929d60a359225b30',
  'url-domain-policy.json':'e6fa88694fe1142f8754c2e50cbee752a9755d63324247aaa9db465450d5672e',
  'url-contextj.json':'5cf9aee605cd002a75d929da35fe0f6bcb99b2dd83a78a71751dc24b95adadd8',
};
const fixtures=Object.entries(fixturePins).map(([name,hash])=>({name,bytes:read(`fixtures/${name}`,hash)}));
const target=path.join(root,'src/protocol-v4');
const managed=['src','src/protocol-v4','src/protocol-v4/idna','src/protocol-v4/PROVENANCE.json','src/operational-state.mjs','test','test/fixtures','test/fixtures/cms-v4',
  ...members.map(member=>`src/protocol-v4/${member.target}`),...fixtures.map(fixture=>`test/fixtures/cms-v4/${fixture.name}`)];
for(const name of managed) if(fs.lstatSync(path.join(root,name),{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Linked managed target');
const stateFile=path.join(root,'src/operational-state.mjs');
const state=fs.readFileSync(stateFile,'utf8');
const pattern=/runtime_sha256: "[a-f0-9]{64}"/g;
if([...state.matchAll(pattern)].length!==1) throw new Error('Ambiguous current runtime identity');
for(const member of members) {
  const file=path.join(target,member.target);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,member.bytes);
}
for(const fixture of fixtures) {
  const file=path.join(root,'test/fixtures/cms-v4',fixture.name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,fixture.bytes);
}
const provenance={wire_version:'v4',status:candidate.status,implementation_version:candidate.implementation_version,release_version:null,candidate_id:pins.candidate,
  source:{repository:'https://github.com/DiscussionBridge/discussionbridge-adapter-contract',commit:pins.commit},
  normative:{path:'normative/CONTRACT.json',bytes:normative.length,sha256:pins.normative},
  javascript:{bytes:members[0].bytes.length,sha256:pins.runtime},schema:{bytes:members[1].bytes.length,sha256:pins.schema},
  embedded_dependencies:{manifest:'idna/DEPENDENCIES.json',licenses:'idna/LICENSES.txt',embedded_in:'cms-runtime.mjs',sha256:pins.dependencies},
  members:members.map(member=>({path:member.target,bytes:member.bytes.length,sha256:sha(member.bytes)})),
  development_fixtures:fixtures.map(fixture=>({path:`test/fixtures/cms-v4/${fixture.name}`,bytes:fixture.bytes.length,sha256:sha(fixture.bytes)})),
  limitation:'Exact shared runtime bytes only; no native ownership, state migration, installed-profile or release authority.'};
fs.writeFileSync(path.join(target,'PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');
fs.writeFileSync(stateFile,state.replace(pattern,`runtime_sha256: "${pins.runtime}"`));
console.log(JSON.stringify({candidate:pins.candidate,private_members:members.length,fixtures:fixtures.length,source_commit:pins.commit}));
