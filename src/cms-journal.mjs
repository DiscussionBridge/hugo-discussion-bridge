import { createHash, randomUUID } from "node:crypto";
import { nativeOsLock, getCmsProcessIdentity as processIdentity } from "./native-lock.mjs";
import { safeAncestors, syncDirectory, durableDirectory, readRegular, openRegular, fileFingerprint, nativePath } from "./native-io.mjs";
export { assertCmsSafePath, createCmsPrivateDirectory, getCmsProcessIdentity, withCmsNativeLock } from "./native-lock.mjs";
import { link, lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { cmsCanonicalToken, cmsOpaque, cmsUrl, cmsUuid, hashCmsOwnershipReceipt, validateCmsOwnershipReceipt } from "./cms-ownership.mjs";
import { cmsPayloadFileInfo, copyCmsPayloadFile } from "./cms-payload-spool.mjs";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";
import { validateSourceCapture } from "./source-preparation.mjs";

const SCHEMA = "db-hugo-cms-journal-2";
const HASH = /^[a-f0-9]{64}$/u;
const same = (a, b) => semantic(a) === semantic(b);
const digest = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const semantic = (value) => JSON.stringify(value, (_, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);

function requireAuthority(value) {
  const fields = ["work_id", "lease_generation", "source_revision", "policy_revision"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field)) || !cmsUuid(value.work_id)
      || !Number.isSafeInteger(value.lease_generation) || value.lease_generation < 1
      || (value.source_revision !== null && !cmsOpaque(value.source_revision, 128)) || !cmsOpaque(value.policy_revision, 128)) {
    throw new Error("CMS journal requires secret-free exact lease authority.");
  }
}

function assertSecretFree(value) {
  if (Array.isArray(value)) { for (const child of value) assertSecretFree(child); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:lease_token|connection_secret|secret|credentials|authorization)$/iu.test(key)) throw new Error("CMS journal cannot store credentials.");
    assertSecretFree(child);
  }
}

function exactFields(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function instant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRepresentation(value) {
  if (value?.kind === "full") return exactFields(value, ["kind", "source_content_sha256"]) && HASH.test(value.source_content_sha256);
  return value?.kind === "native_excerpt" && exactFields(value, ["kind", "source_content_sha256", "native_limit_bytes", "native_constraint_code", "read_more_url"])
    && HASH.test(value.source_content_sha256) && Number.isSafeInteger(value.native_limit_bytes) && value.native_limit_bytes > 0
    && cmsOpaque(value.native_constraint_code) && cmsUrl(value.read_more_url);
}

function validateMutationPayload(operation, payload, transaction) {
  const common = ["mutation_id", "authority", "transaction_id"];
  const keys = operation === "prepare" ? [...common, "native_result", "prepared_at"]
    : operation === "finalize" ? [...common, "deployment_id", "deployed_at", "verification"]
      : [...common, "native_restored", "safe_detail"];
  if (!exactFields(payload, keys)) throw new Error("CMS request does not match the approved static wire fields.");
  const receipt = transaction.receipt;
  if (operation === "prepare") {
    const result = payload.native_result;
    const resultKeys = ["kind", "native_id", "external_id", "canonical_url", "native_revision", "ownership_receipt_sha256"];
    if (transaction.action === "publish_revision") resultKeys.push("representation");
    if (!exactFields(result, resultKeys) || result.kind !== transaction.action || result.native_id !== receipt.native_id
        || result.external_id !== receipt.external_id || result.canonical_url !== receipt.canonical_url
        || (result.native_revision !== null && !cmsOpaque(result.native_revision, 128))
        || result.ownership_receipt_sha256 !== hashCmsOwnershipReceipt(receipt) || !instant(payload.prepared_at)
        || (result.kind === "publish_revision" && !validateRepresentation(result.representation))) throw new Error("CMS preparation native result is invalid.");
  } else if (operation === "finalize") {
    const verification = payload.verification;
    const published = transaction.action === "publish_revision";
    const proofKeys = published ? ["kind", "url", "native_id", "source_revision", "source_content_sha256", "native_publication_sha256", "verification_profile", "checked_at", "representation"]
      : ["kind", "url", "native_id", "checked_at", "http_status"];
    if (!cmsOpaque(payload.deployment_id) || !instant(payload.deployed_at) || !exactFields(verification, proofKeys)
        || verification.kind !== (published ? "published" : "absent") || verification.url !== receipt.canonical_url
        || verification.native_id !== receipt.native_id || !instant(verification.checked_at)
        || verification.checked_at < payload.deployed_at || verification.checked_at < transaction.prepared_at
        || (published ? verification.source_revision !== receipt.source_revision || !HASH.test(verification.source_content_sha256)
          || !HASH.test(verification.native_publication_sha256) || !cmsOpaque(verification.verification_profile)
          || !validateRepresentation(verification.representation) || !same(verification.representation, transaction.native_result.representation)
          || verification.source_content_sha256 !== transaction.native_result.representation.source_content_sha256
          : ![404, 410].includes(verification.http_status))) throw new Error("CMS finalization public report is invalid.");
  } else if (typeof payload.native_restored !== "boolean" || (payload.safe_detail !== null && !cmsOpaque(payload.safe_detail, 200))) {
    throw new Error("CMS abort report is invalid.");
  }
}


async function writeSource(handle, source) {
  if (!Buffer.isBuffer(source) && source?.privateCapability) return await copyCmsPayloadFile(source.privateCapability, handle, source.binding);
  let input;
  try {
    if (Buffer.isBuffer(source)) input = [source];
    else {
      const opened = await openRegular(source.payloadFile);
      if (opened === null) throw new Error("CMS native snapshot payload is unavailable.");
      input = opened.createReadStream({ autoClose: true });
    }
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of input) {
      hash.update(chunk); bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) throw new Error("CMS native byte counter exhausted.");
      await handle.writeFile(chunk);
    }
    const sha256 = hash.digest("hex");
    if (!Buffer.isBuffer(source) && sha256 !== source.sha256) throw new Error("CMS private snapshot bytes changed; native commit refused.");
    return { sha256, bytes };
  } finally { if (input && !Array.isArray(input)) input.destroy(); }
}

async function immutablePayload(file, source, expectedSha256, expectedBytes) {
  await durableDirectory(path.dirname(file));
  const existing = await fileFingerprint(file);
  if (existing.sha256 !== null) {
    if (existing.sha256 !== expectedSha256 || (expectedBytes !== undefined && existing.bytes !== expectedBytes)) throw new Error("CMS immutable native snapshot conflicts.");
    return existing;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    const fingerprint = await writeSource(handle, source);
    if (fingerprint.sha256 !== expectedSha256 || (expectedBytes !== undefined && fingerprint.bytes !== expectedBytes)) throw new Error("CMS snapshot source changed during staging.");
    await handle.sync(); await handle.close(); handle = undefined;
    await safeAncestors(file); await link(temporary, file); await syncDirectory(path.dirname(file));
    return fingerprint;
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

async function replaceRegular(file, contents, expected) {
  await durableDirectory(path.dirname(file));
  if ((await fileFingerprint(file)).sha256 !== expected) throw new Error("CMS native file changed before commit.");
  if (contents === null) {
    if (expected !== null) await rm(file);
    await syncDirectory(path.dirname(file));
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeSource(handle, contents); await handle.sync(); await handle.close(); handle = undefined;
    await safeAncestors(file);
    if ((await fileFingerprint(file)).sha256 !== expected) throw new Error("CMS native file changed during commit.");
    if (expected === null) await link(temporary, file);
    else await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}


function validateFileSnapshots(files, mappingId) {
  if (!Array.isArray(files) || !files.length) throw new Error("CMS transaction files are invalid.");
  const names = new Set();
  for (const file of files) {
    if (!exactFields(file, ["path", "before_payload", "before_sha256", "before_bytes", "after_payload", "after_sha256", "after_bytes"])) throw new Error("CMS file snapshot fields are invalid.");
    nativePath(path.resolve("."), file.path);
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (names.has(key)) throw new Error("CMS transaction contains duplicate paths.");
    names.add(key);
    for (const side of ["before", "after"]) {
      const payload = file[`${side}_payload`], hash = file[`${side}_sha256`], bytes = file[`${side}_bytes`];
      if (payload === null) {
        if (hash !== null || bytes !== null) throw new Error("CMS absent file snapshot is invalid.");
      } else {
        nativePath(path.resolve("."), payload);
        const parts = payload.split("/");
        if (parts.length !== 4 || parts[0] !== ".payloads" || parts[1] !== mappingId || !cmsUuid(parts[2])
            || !/^(?:0|[1-9][0-9]*)-(?:before|after)\.bin$/u.test(parts[3]) || !HASH.test(hash)
            || !Number.isSafeInteger(bytes) || bytes < 0 || Object.is(bytes, -0)) throw new Error("CMS private file snapshot is invalid.");
      }
    }
  }
}

function validatePresentationMove(value, mappingId) {
  const fields = ["move", "authority", "old_receipt", "receipt", "prior_verified", "files", "phase", "had_native_change", "baseline_pending", "verification", "deployment", "mapping_response", "rollback_id", "rollback_verification", "abort_response", "failure_code", "history"];
  if (!exactFields(value, fields) || !["staged", "applied", "restored", "committed", "aborted", "attention"].includes(value.phase)
      || typeof value.had_native_change !== "boolean" || typeof value.baseline_pending !== "boolean" || !Array.isArray(value.history)) throw new Error("CMS native presentation move state is invalid.");
  validateCms("UrlMove", value.move); requireAuthority(value.authority);
  for (const receipt of [value.old_receipt, value.receipt]) {
    validateCmsOwnershipReceipt(receipt);
    if (receipt.mapping_id !== mappingId || receipt.last_lease_generation !== value.authority.lease_generation || receipt.source_revision !== value.authority.source_revision) throw new Error("CMS presentation move receipt authority is invalid.");
  }
  const old = value.old_receipt, current = value.receipt;
  if (!same(nativeIdentityBinding(old), nativeIdentityBinding(current)) || old.canonical_url !== value.move.old_url || current.canonical_url !== value.move.new_url
      || current.move_id !== value.move.move_id || current.proof_nonce !== value.move.proof_nonce || value.move.mapping_id !== mappingId
      || value.prior_verified?.phase !== "verified" || !same(stableBinding(value.prior_verified.receipt), stableBinding(old))) throw new Error("CMS presentation move ancestry is invalid.");
  validateFileSnapshots(value.files, mappingId);
  validateFileSnapshots(value.prior_verified.files, mappingId);
  validateCms("SyncResult", value.prior_verified.native_result);
  validateCms("WorkQueryResponse", value.prior_verified.finalize_receiver_receipt);
  if (value.verification !== null) validateCms("PublishedVerification", value.verification);
  if (value.verification !== null && (value.verification.url !== current.canonical_url || value.verification.native_id !== current.native_id
      || value.verification.source_revision !== current.source_revision
      || value.verification.source_content_sha256 !== value.prior_verified.native_result?.representation?.source_content_sha256
      || !same(value.verification.representation, value.prior_verified.native_result.representation))) throw new Error("CMS retained presentation proof has changed its source/native identity.");
  if (value.mapping_response !== null) validateCms("Mapping", value.mapping_response);
  if (value.abort_response !== null) validateCms("UrlMove", value.abort_response);
  if (value.failure_code !== null && value.failure_code !== "public_verification_failed") throw new Error("CMS presentation failure classification is invalid.");
  if (value.rollback_id !== null && !cmsUuid(value.rollback_id)) throw new Error("CMS presentation restoration identity is invalid.");
  if (value.rollback_verification !== null) validateCms("PublishedVerification", value.rollback_verification);
  if (value.deployment !== null && (!exactFields(value.deployment, ["deployment_id", "deployed_at"]) || !cmsOpaque(value.deployment.deployment_id) || !instant(value.deployment.deployed_at))) throw new Error("CMS presentation deployment receipt is invalid.");
  if (value.phase === "committed" && (value.mapping_response === null || value.verification === null || value.deployment === null)
      || value.baseline_pending && value.phase !== "committed") throw new Error("CMS presentation move has no accepted native baseline.");
  for (const prior of value.history) { if (prior.history?.length) throw new Error("CMS presentation move history is not flat."); validatePresentationMove(prior, mappingId); }
}

function validateJournal(value, mappingId) {
  assertSecretFree(value);
  if (!exactFields(value, ["schema_version", "mapping_id", "last_lease_generation", "authority", "transaction", "last_verified", "pending_mutation"])
      || value.schema_version !== SCHEMA || value.mapping_id !== mappingId
      || !Number.isSafeInteger(value.last_lease_generation) || value.last_lease_generation < 0
      || !Object.hasOwn(value, "transaction") || !Object.hasOwn(value, "last_verified") || !Object.hasOwn(value, "pending_mutation")) throw new Error("CMS journal is invalid.");
  if (value.authority !== null) { requireAuthority(value.authority); if (value.authority.lease_generation !== value.last_lease_generation) throw new Error("CMS journal fence is invalid."); }
  else if (value.last_lease_generation !== 0) throw new Error("CMS journal fence is invalid.");
  const transaction = value.transaction;
  if (transaction !== null) {
    if (!cmsUuid(transaction.transaction_id) || !["publish_revision", "withdraw"].includes(transaction.action)
        || !["staged", "applied", "verified", "restored", "attention"].includes(transaction.phase)
        || typeof transaction.receiver_prepared !== "boolean"
        || !Array.isArray(transaction.files) || transaction.files.length < 1) throw new Error("CMS transaction is invalid.");
    requireAuthority(transaction.authority); validateCmsOwnershipReceipt(transaction.receipt);
    if (transaction.receipt.mapping_id !== mappingId || transaction.receipt.last_lease_generation !== transaction.authority.lease_generation
        || transaction.receipt.source_revision !== transaction.authority.source_revision
        || (transaction.action === "publish_revision") !== (transaction.authority.source_revision !== null)) throw new Error("CMS transaction receipt is invalid.");
    validateFileSnapshots(transaction.files, mappingId);
    if (transaction.source_capture !== undefined) {
      const capture = validateSourceCapture(transaction.source_capture);
      if (capture.source_id !== transaction.receipt.source_id || capture.source_revision !== transaction.authority.source_revision) throw new Error("CMS native original capture binding is invalid.");
    }
    if (transaction.presentation_move !== undefined) validatePresentationMove(transaction.presentation_move, mappingId);
  }
  if (value.last_verified !== null) {
    const verified = value.last_verified;
    if (!verified || verified.phase !== "verified" || verified.receiver_prepared !== true || !cmsUuid(verified.transaction_id)
        || !instant(verified.prepared_at) || !Array.isArray(verified.files) || !verified.files.length) throw new Error("CMS prior verified state is invalid.");
    requireAuthority(verified.authority); validateCmsOwnershipReceipt(verified.receipt);
    if (verified.receipt.mapping_id !== mappingId || verified.receipt.last_lease_generation !== verified.authority.lease_generation) throw new Error("CMS verified ownership is invalid.");
    validateFileSnapshots(verified.files, mappingId);
    if (verified.presentation_move !== undefined) validatePresentationMove(verified.presentation_move, mappingId);
  }
  if (value.pending_mutation !== null) {
    const pending = value.pending_mutation;
    requireAuthority(pending.payload.authority);
    if (!cmsUuid(pending.payload.mutation_id) || !HASH.test(pending.token_sha256)
        || !["prepare", "finalize", "abort"].includes(pending.operation)
        || pending.payload.transaction_id !== transaction?.transaction_id) throw new Error("CMS pending mutation is invalid.");
    validateMutationPayload(pending.operation, pending.payload, transaction);
  }
  return value;
}


async function ownerDisposition(owner) {
  if (!owner || owner.lock_version !== "db-native-lock-2" || !cmsUuid(owner.lock_nonce)
      || owner.process_identity?.platform !== process.platform || owner.owner_pid !== owner.process_identity?.pid
      || !/^[0-9]+$/u.test(owner.process_identity?.start ?? "")
      || (process.platform === "linux" && (owner.process_identity.uid !== process.getuid() || !cmsUuid(owner.process_identity.boot)))) return "unknown";
  const current = await processIdentity(owner.owner_pid);
  if (current.state === "absent") return "dead";
  if (current.state !== "present") return "unknown";
  return same(current.identity, owner.process_identity) ? "alive" : "unknown"; // PID reuse never authorizes takeover.
}


export async function withCmsJournal({ journalRoot, nativeRoot, mappingId }, authority, action) {
  requireAuthority(authority);
  if (!cmsUuid(mappingId)) throw new Error("CMS mapping ID is invalid.");
  journalRoot = path.resolve(journalRoot); nativeRoot = path.resolve(nativeRoot);
  if (/(?:^|[\\/])(?:public|static|assets)(?:[\\/]|$)/iu.test(journalRoot)) throw new Error("CMS journal must stay outside public output directories.");
  if (journalRoot === nativeRoot || !path.relative(nativeRoot, journalRoot).startsWith("..")) throw new Error("CMS journal must stay outside the native publication root.");
  await durableDirectory(journalRoot); await safeAncestors(nativeRoot);
  const journalFile = path.join(journalRoot, `${mappingId}.json`);
  const lockPath = path.join(journalRoot, `${mappingId}.lock`);
  const ownerFile = path.join(lockPath, "owner.json");
  let locked = false;
  let ownerHash = null;
  const osLock = await nativeOsLock(path.join(journalRoot, `${mappingId}.os-lock`));
  try {
    await osLock.assertHeld();
    const ownIdentity = await processIdentity(process.pid);
    if (ownIdentity.state !== "present") throw Object.assign(new Error("CMS native process start identity is unavailable; locking needs attention."), { native_process_probe: ownIdentity });
    try { await mkdir(lockPath, { mode: 0o700 }); locked = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const oldBytes = await readRegular(ownerFile);
      let oldOwner; try { oldOwner = JSON.parse(oldBytes?.toString("utf8") ?? "null"); } catch { oldOwner = null; }
      if (await ownerDisposition(oldOwner) !== "dead") throw new Error("CMS mapping is locked; live, reused or unknown owner needs attention.");
      await osLock.assertHeld();
      if (digest(await readRegular(ownerFile)) !== digest(oldBytes)) throw new Error("CMS abandoned owner changed; recovery refused.");
      await rm(ownerFile); await rmdir(lockPath); await syncDirectory(journalRoot);
      await mkdir(lockPath, { mode: 0o700 }); locked = true;
    }
    const ownerBytes = Buffer.from(JSON.stringify({ lock_version: "db-native-lock-2", lock_nonce: randomUUID(), owner_pid: process.pid,
      process_identity: ownIdentity.identity }));
    await replaceRegular(ownerFile, ownerBytes, null); ownerHash = digest(ownerBytes);
    await syncDirectory(journalRoot);
    const bytes = await readRegular(journalFile);
    const state = bytes === null ? { schema_version: SCHEMA, mapping_id: mappingId, last_lease_generation: 0, authority: null, transaction: null, last_verified: null, pending_mutation: null }
      : validateJournal(JSON.parse(bytes.toString("utf8")), mappingId);
    let journalHash = digest(bytes);
    const save = async () => {
      validateJournal(state, mappingId);
      const output = Buffer.from(`${JSON.stringify(state)}\n`);
      await replaceRegular(journalFile, output, journalHash); journalHash = digest(output);
    };
    if (authority.lease_generation < state.last_lease_generation
        || (authority.lease_generation === state.last_lease_generation && !same(authority, state.authority))) throw new Error("CMS native fencing generation is stale or conflicts.");
    state.last_lease_generation = authority.lease_generation; state.authority = structuredClone(authority);
    await save();
    const assertFence = async () => {
      await osLock.assertHeld();
      const current = await readRegular(journalFile);
      if (digest(current) !== journalHash || digest(await readRegular(ownerFile)) !== ownerHash
          || !(await lstat(lockPath)).isDirectory()) throw new Error("CMS native lock or durable fence changed.");
    };
    const snapshotFiles = async (files, transactionId, priorFiles) => {
      const snapshots = [];
      for (const [index, file] of files.entries()) {
        const target = nativePath(nativeRoot, file.path), before = await fileFingerprint(target);
        if (file.expectedSha256 !== before.sha256) throw new Error("CMS staged native revision does not match.");
        if (before.sha256 !== null && !priorFiles?.some((prior) => prior.path === file.path && prior.after_sha256 === before.sha256)) throw new Error("CMS existing native file has no verified journal ownership; native reconciliation is required.");
        const binding = { nativeRoot, journalRoot, mappingId };
        const payload = file.bytes !== null && !Buffer.isBuffer(file.bytes) ? await cmsPayloadFileInfo(file.bytes, binding) : null;
        const beforePayload = before.sha256 === null ? null : `.payloads/${mappingId}/${transactionId}/${index}-before.bin`;
        const afterPayload = file.bytes === null ? null : `.payloads/${mappingId}/${transactionId}/${index}-after.bin`;
        if (beforePayload !== null) await immutablePayload(nativePath(journalRoot, beforePayload), { payloadFile: target, sha256: before.sha256 }, before.sha256);
        const after = file.bytes === null ? { sha256: null, bytes: null } : await immutablePayload(nativePath(journalRoot, afterPayload), payload ? { privateCapability: file.bytes, binding } : file.bytes, payload ? payload.sha256 : digest(file.bytes), payload?.bytes);
        snapshots.push({ path: file.path, before_payload: beforePayload, before_sha256: before.sha256, before_bytes: before.bytes, after_payload: afterPayload, after_sha256: after.sha256, after_bytes: after.bytes });
      }
      validateFileSnapshots(snapshots, mappingId); return snapshots;
    };
    const currentMove = () => {
      const move = state.transaction?.presentation_move;
      if (!move || !same(move.authority, authority)) throw new Error("CMS presentation move replacement authority requires native reconciliation; reservations retained.");
      return move;
    };
    const writeSnapshots = async (files, side) => {
      for (const file of files) {
        await assertFence(); const target = nativePath(nativeRoot, file.path), current = (await fileFingerprint(target)).sha256;
        if (current === file[`${side}_sha256`]) continue;
        const other = side === "before" ? "after" : "before";
        if (current !== file[`${other}_sha256`]) throw new Error("CMS presentation native file changed; reconciliation is required.");
        await replaceRegular(target, file[`${side}_payload`] === null ? null : { payloadFile: nativePath(journalRoot, file[`${side}_payload`]), sha256: file[`${side}_sha256`] }, current);
      }
    };
    const context = {
      snapshot: () => structuredClone(state),
      async inspectPresentationOrigin(receipt) {
        await assertFence(); validateCmsOwnershipReceipt(receipt);
        const prior = state.last_verified, move = state.transaction?.presentation_move;
        if (!prior || state.pending_mutation !== null || !["verified", "restored"].includes(state.transaction?.phase)
            || move && (!(["committed", "aborted"].includes(move.phase)) || move.baseline_pending)
            || !same(stableBinding(prior.receipt), stableBinding(receipt)) || prior.receipt.source_revision !== authority.source_revision
            || receipt.source_revision !== authority.source_revision || receipt.last_lease_generation !== authority.lease_generation) throw new Error("CMS presentation move requires exact currently owned verified native publication.");
        for (const file of prior.files) if ((await fileFingerprint(nativePath(nativeRoot, file.path))).sha256 !== file.after_sha256) throw new Error("CMS presentation origin was edited outside its verified native journal.");
        return structuredClone(prior);
      },
      async stagePresentationMove({ move, oldReceipt, receipt, files }) {
        await assertFence(); validateCms("UrlMove", move); validateCmsOwnershipReceipt(receipt);
        const existing = state.transaction?.presentation_move;
        if (existing?.move.move_id === move.move_id) {
          if (!same(existing.move, move) || !same(existing.authority, authority) || !same(existing.receipt, receipt)) throw new Error("CMS presentation move identity changed.");
          return context.snapshot();
        }
        const prior = await context.inspectPresentationOrigin(oldReceipt), history = existing ? [...existing.history, { ...structuredClone(existing), history: [] }] : [];
        delete prior.presentation_move;
        const snapshots = await snapshotFiles(files, move.move_id, prior.files);
        if (snapshots.length !== prior.files.length || prior.files.some((file) => !snapshots.some((snapshot) => snapshot.path === file.path))) throw new Error("CMS presentation move must retain the complete owned file manifest.");
        state.transaction.presentation_move = { move: structuredClone(move), authority: structuredClone(authority), old_receipt: structuredClone(oldReceipt), receipt: structuredClone(receipt), prior_verified: prior,
          files: snapshots, phase: "staged", had_native_change: false, baseline_pending: false, verification: null, deployment: null, mapping_response: null, rollback_id: null, rollback_verification: null, abort_response: null, failure_code: null, history };
        await save(); return context.snapshot();
      },
      async presentationChangeApplied() {
        await assertFence(); const move = currentMove();
        for (const file of move.files) {
          const current = (await fileFingerprint(nativePath(nativeRoot, file.path))).sha256;
          if (current !== file.before_sha256) { move.had_native_change = true; await save(); return true; }
        }
        return move.had_native_change;
      },
      async applyPresentationMove() {
        await assertFence(); const move = currentMove();
        if (!["staged", "applied"].includes(move.phase)) throw new Error("CMS presentation move cannot apply in this state.");
        await writeSnapshots(move.files, "after"); move.had_native_change = true; move.phase = "applied"; await save(); return context.snapshot();
      },
      async restorePresentationMove() {
        await assertFence(); const move = currentMove();
        if (["committed", "aborted", "attention"].includes(move.phase)) throw new Error("CMS settled presentation move cannot restore automatically.");
        await context.presentationChangeApplied(); await writeSnapshots(move.files, "before"); move.phase = "restored"; await save(); return context.snapshot();
      },
      async recordPresentationProof(verification, deployment) {
        await assertFence(); const move = currentMove(); validateCms("PublishedVerification", verification);
        if (move.phase !== "applied" || verification.url !== move.receipt.canonical_url || verification.native_id !== move.receipt.native_id
            || verification.source_revision !== move.receipt.source_revision || verification.checked_at < move.move.prepared_at
            || verification.checked_at < deployment.deployed_at || verification.source_content_sha256 !== move.prior_verified.native_result.representation.source_content_sha256
            || !same(verification.representation, move.prior_verified.native_result.representation)) throw new Error("CMS presentation proof does not match actual native move.");
        move.verification = structuredClone(verification); move.deployment = structuredClone(deployment); await save();
      },
      async acceptPresentationCommit(mapping) {
        await assertFence(); const move = currentMove(); validateCms("Mapping", mapping);
        if (!["applied", "committed"].includes(move.phase) || !move.verification || !move.deployment || mapping.mapping_id !== mappingId
            || mapping.resource_id !== move.receipt.resource_id || mapping.source_id !== move.receipt.source_id || mapping.external_id !== move.receipt.external_id
            || mapping.connection_id !== move.receipt.connection_id
            || mapping.destination_native_id !== move.receipt.native_id || mapping.canonical_url !== move.receipt.canonical_url
            || mapping.mapping_revision === move.move.expected_mapping_revision || mapping.desired_source_revision !== authority.source_revision
            || mapping.presentation_mode !== move.prior_verified.finalize_receiver_receipt.mapping.presentation_mode
            || move.mapping_response && !same(move.mapping_response, mapping)) throw new Error("CMS presentation commit receipt mismatches its exact native move.");
        move.mapping_response = structuredClone(mapping); move.phase = "committed"; move.baseline_pending = true; await save(); return context.snapshot();
      },
      async presentationRollbackIdentity() {
        await assertFence(); const move = currentMove(); move.rollback_id ??= randomUUID(); await save(); return move.rollback_id;
      },
      async recordPresentationRollbackProof(verification) {
        await assertFence(); const move = currentMove(); validateCms("PublishedVerification", verification);
        if (move.phase !== "restored" || verification.url !== move.old_receipt.canonical_url || verification.native_id !== move.old_receipt.native_id
            || verification.source_revision !== move.old_receipt.source_revision) throw new Error("CMS restored presentation proof mismatches actual old native identity.");
        move.rollback_verification = structuredClone(verification); await save();
      },
      async recordPresentationPublicFailure() {
        await assertFence(); const move = currentMove(); move.failure_code = "public_verification_failed"; await save();
      },
      async acceptPresentationAbort(response, rollbackVerification = null) {
        await assertFence(); const move = currentMove(); validateCms("UrlMove", response);
        if (response.move_id !== move.move.move_id || response.mapping_id !== mappingId || !["aborted", "attention"].includes(response.state)
            || response.new_url !== move.move.new_url || response.old_url !== move.move.old_url || move.had_native_change && response.state !== "attention") throw new Error("CMS presentation abort receipt mismatches actual native changes.");
        if (rollbackVerification !== null) validateCms("PublishedVerification", rollbackVerification);
        move.abort_response = structuredClone(response); if (rollbackVerification !== null) move.rollback_verification = structuredClone(rollbackVerification); move.phase = response.state; await save(); return context.snapshot();
      },
      async stage({ transactionId, action: workAction, receipt, files, sourceCapture }) {
        await assertFence(); validateCmsOwnershipReceipt(receipt);
        if (!cmsUuid(transactionId) || !["publish_revision", "withdraw"].includes(workAction)
            || receipt.mapping_id !== mappingId || receipt.last_lease_generation !== authority.lease_generation
            || receipt.source_revision !== authority.source_revision || (workAction === "publish_revision") !== (authority.source_revision !== null)
            || !Array.isArray(files) || !files.length) throw new Error("CMS staged identity or authority is invalid.");
        if (state.pending_mutation !== null) throw new Error("CMS pending mutation must be reconciled before changing transaction authority.");
        if (state.transaction && !["verified", "restored"].includes(state.transaction.phase)) throw new Error("CMS open transaction requires reconciliation.");
        const move = state.transaction?.presentation_move;
        if (move && !["committed", "aborted"].includes(move.phase)) throw new Error("CMS presentation move requires reconciliation before publication staging.");
        const nativeBaseline = move?.baseline_pending ? { receipt: move.receipt, files: move.files } : state.last_verified;
        if (state.transaction && !move?.baseline_pending && !same(stableBinding(state.transaction.receipt), stableBinding(receipt))) throw new Error("CMS reserved native identity cannot change after an aborted preparation.");
        if (nativeBaseline && !same(stableBinding(nativeBaseline.receipt), stableBinding(receipt))) throw new Error("CMS verified native identity cannot change during a normal revision.");
        if (workAction === "withdraw" && state.last_verified === null) throw new Error("CMS withdrawal requires previously owned verified native identity.");
        const snapshots = await snapshotFiles(files, transactionId, nativeBaseline?.files);
        state.transaction = { transaction_id: transactionId, action: workAction, authority: structuredClone(authority), receipt: structuredClone(receipt), phase: "staged", receiver_prepared: false, prior_verified: structuredClone(state.last_verified), files: snapshots };
        if (sourceCapture !== undefined) state.transaction.source_capture = structuredClone(validateSourceCapture(sourceCapture));
        if (move) state.transaction.presentation_move = structuredClone(move);
        await save(); return context.snapshot();
      },
      async rebind(transactionId, receipt) {
        await assertFence(); validateCmsOwnershipReceipt(receipt);
        const transaction = state.transaction;
        if (!transaction || transaction.transaction_id !== transactionId || !["staged", "applied"].includes(transaction.phase)
            || transaction.authority.source_revision !== authority.source_revision || transaction.authority.policy_revision !== authority.policy_revision
            || transaction.authority.work_id !== authority.work_id || state.pending_mutation !== null
            || !same({ ...transaction.receipt, last_lease_generation: receipt.last_lease_generation }, receipt)
            || receipt.last_lease_generation !== authority.lease_generation) throw new Error("CMS prepared transaction cannot be rebound without exact reconciled identity.");
        for (const file of transaction.files) {
          const current = (await fileFingerprint(nativePath(nativeRoot, file.path))).sha256;
          if (current !== file.before_sha256 && current !== file.after_sha256) throw new Error("CMS prepared native file needs reconciliation.");
        }
        transaction.authority = structuredClone(authority); transaction.receipt = structuredClone(receipt);
        transaction.receiver_prepared = false; // A replacement generation must repeat prepare before finalize/abort.
        await save(); return context.snapshot();
      },
      async apply(transactionId, { afterFile } = {}) {
        await assertFence();
        const transaction = currentTransaction(state, transactionId, authority);
        if (!["staged", "applied"].includes(transaction.phase)) throw new Error("CMS transaction cannot apply in this state.");
        for (const file of transaction.files) {
          await assertFence();
          const target = nativePath(nativeRoot, file.path), current = (await fileFingerprint(target)).sha256;
          if (current !== file.after_sha256) {
            if (current !== file.before_sha256) throw new Error("CMS native file needs reconciliation; staged write refused.");
            await replaceRegular(target, file.after_payload === null ? null : { payloadFile: nativePath(journalRoot, file.after_payload), sha256: file.after_sha256 }, current);
          }
          await afterFile?.(file.path);
        }
        transaction.phase = "applied"; await save(); return context.snapshot();
      },
      async restore(transactionId) {
        await assertFence();
        const transaction = currentTransaction(state, transactionId, authority);
        if (transaction.phase === "verified") throw new Error("CMS verified transaction cannot abort.");
        for (const file of transaction.files) {
          await assertFence();
          const target = nativePath(nativeRoot, file.path), current = (await fileFingerprint(target)).sha256;
          if (current !== file.before_sha256) {
            if (current !== file.after_sha256) throw new Error("CMS native restore requires reconciliation; changed local file retained.");
            await replaceRegular(target, file.before_payload === null ? null : { payloadFile: nativePath(journalRoot, file.before_payload), sha256: file.before_sha256 }, current);
          }
        }
        transaction.phase = "restored"; state.last_verified = structuredClone(transaction.prior_verified);
        await save(); return { native_restored: true, previous_verified: structuredClone(state.last_verified),
          native_baseline: structuredClone(transaction.presentation_move?.baseline_pending ? transaction.presentation_move.receipt : state.last_verified?.receipt ?? null) };
      },
      async queueMutation(operation, payload, leaseToken) {
        await assertFence(); assertSecretFree(payload);
        const transaction = currentTransaction(state, payload?.transaction_id, authority);
        if (!cmsCanonicalToken(leaseToken) || !cmsUuid(payload?.mutation_id) || !same(payload.authority, authority)
            || !["prepare", "finalize", "abort"].includes(operation)) throw new Error("CMS pending request is invalid.");
        if (operation === "prepare" && transaction.phase !== "applied") throw new Error("CMS prepare requires a durable applied native stage.");
        if (operation === "finalize" && (!transaction.receiver_prepared || transaction.phase !== "applied")) throw new Error("CMS finalize requires receiver-accepted exact preparation.");
        if (operation === "abort" && (!transaction.receiver_prepared || transaction.phase === "verified"
            || (payload.native_restored === true && transaction.phase !== "restored"))) throw new Error("CMS abort requires accepted preparation and truthful restoration.");
        validateMutationPayload(operation, payload, transaction);
        if (JSON.stringify(payload).includes(leaseToken)) throw new Error("CMS journal cannot store a lease credential in payload values.");
        const pending = { operation, payload: structuredClone(payload), token_sha256: digest(Buffer.from(leaseToken, "utf8")) };
        if (state.pending_mutation !== null && !same(state.pending_mutation, pending)) throw new Error("CMS pending mutation identity/payload cannot change before reconciliation.");
        state.pending_mutation = pending; await save(); return context.pendingRequest(leaseToken);
      },
      pendingRequest(leaseToken) {
        if (!state.pending_mutation || !cmsCanonicalToken(leaseToken)
            || digest(Buffer.from(leaseToken, "utf8")) !== state.pending_mutation.token_sha256) throw new Error("CMS original pending credential is unavailable; reconcile receiver status before another mutation.");
        const pending = structuredClone(state.pending_mutation);
        pending.payload.authority.lease_token = leaseToken;
        return { operation: pending.operation, payload: pending.payload };
      },
      async acceptMutation(mutationId, receiverResponse) {
        await assertFence();
        const pending = state.pending_mutation;
        assertSecretFree(receiverResponse);
        const receiverState = receiverResponse?.work?.state;
        const responseAuthority = receiverResponse?.work;
        const responseMapping = receiverResponse?.mapping;
        if (!pending || pending.payload.mutation_id !== mutationId || !exactFields(receiverResponse, ["work", "mapping", "lease_expires_at"])
            || !same(pending.payload.authority, { work_id: responseAuthority?.work_id, lease_generation: responseAuthority?.lease_generation,
              source_revision: responseAuthority?.source_revision, policy_revision: responseAuthority?.policy_revision })
            || responseAuthority?.mapping_id !== mappingId || responseAuthority?.action !== state.transaction.action
            || responseMapping?.mapping_id !== mappingId || responseMapping?.resource_id !== state.transaction.receipt.resource_id
            || responseMapping?.connection_id !== state.transaction.receipt.connection_id || responseMapping?.external_id !== state.transaction.receipt.external_id
            || responseMapping?.destination_native_id !== state.transaction.receipt.native_id || responseMapping?.canonical_url !== state.transaction.receipt.canonical_url
            || (pending.operation === "prepare" && receiverState !== "synchronized")
            || (pending.operation === "finalize" && receiverState !== "verified")
            || (pending.operation === "abort" && receiverState !== "attention")) throw new Error("CMS mutation receipt does not match the pending stage and owned binding.");
        if (pending.operation === "finalize") {
          state.transaction.phase = "verified";
          state.transaction.finalize_report = structuredClone(pending.payload);
          state.transaction.finalize_receiver_receipt = structuredClone(receiverResponse);
          if (state.transaction.presentation_move?.baseline_pending) state.transaction.presentation_move.baseline_pending = false;
          state.last_verified = structuredClone(state.transaction);
          delete state.last_verified.prior_verified;
        }
        if (pending.operation === "prepare") {
          state.transaction.receiver_prepared = true;
          state.transaction.prepared_at = pending.payload.prepared_at;
          state.transaction.native_result = structuredClone(pending.payload.native_result);
          state.transaction.prepare_receiver_receipt = structuredClone(receiverResponse);
        }
        if (pending.operation === "abort") {
          if (pending.payload.native_restored === false) state.transaction.phase = "attention";
          state.transaction.abort_report = structuredClone(pending.payload);
          state.transaction.abort_receiver_receipt = structuredClone(receiverResponse);
        }
        state.pending_mutation = null; await save(); return context.snapshot();
      },
      ownershipHash: () => state.transaction ? hashCmsOwnershipReceipt(state.transaction.receipt) : null,
    };
    return await action(context);
  } finally {
    try { if (locked) {
      if (ownerHash !== null) {
        if (digest(await readRegular(ownerFile)) !== ownerHash) throw new Error("CMS lock ownership changed; another owner's lock is retained.");
        await rm(ownerFile);
      }
      await rmdir(lockPath); await syncDirectory(journalRoot);
    } } finally { await osLock.release(); }
  }
}

function currentTransaction(state, transactionId, authority) {
  const transaction = state.transaction;
  if (!transaction || transaction.transaction_id !== transactionId || !same(transaction.authority, authority)) throw new Error("CMS transaction does not match the current native fence.");
  return transaction;
}

function stableBinding(receipt) {
  return Object.fromEntries(["schema_version", "forum_origin", "connection_id", "mapping_id", "resource_id", "source_id", "external_id", "native_id", "canonical_url"].map((field) => [field, receipt[field]]));
}

function nativeIdentityBinding(receipt) {
  const value = stableBinding(receipt); delete value.canonical_url; value.source_revision = receipt.source_revision; return value;
}

// Attention inspection has no publication lease. In particular it must not use
// withCmsJournal(), which persists authority on entry. The OS exclusion is the
// same exclusion every writer acquires before touching the mapping journal.
async function withCmsRecoveryJournal({ journalRoot, nativeRoot, mappingId }, action) {
  if (!cmsUuid(mappingId)) throw new Error("CMS recovery mapping ID is invalid.");
  journalRoot = path.resolve(journalRoot); nativeRoot = path.resolve(nativeRoot);
  if (journalRoot === nativeRoot || !path.relative(nativeRoot, journalRoot).startsWith("..")
      || /(?:^|[\\/])(?:public|static|assets)(?:[\\/]|$)/iu.test(journalRoot)) throw new Error("CMS recovery journal root is invalid.");
  await durableDirectory(journalRoot); await safeAncestors(nativeRoot); // Lock bookkeeping only; no journal/native content write.
  const file = path.join(journalRoot, `${mappingId}.json`), osLock = await nativeOsLock(path.join(journalRoot, `${mappingId}.os-lock`));
  try {
    await osLock.assertHeld();
    const bytes = await readRegular(file), expected = digest(bytes);
    const state = bytes === null ? null : validateJournal(JSON.parse(bytes.toString("utf8")), mappingId);
    const assertUnchanged = async () => {
      await osLock.assertHeld();
      if (digest(await readRegular(file)) !== expected) throw new Error("CMS inspected journal changed.");
    };
    const snapshots = async (files, side) => {
      validateFileSnapshots(files, mappingId);
      const observed = [];
      for (const entry of files) {
        for (const saved of ["before", "after"]) if (entry[`${saved}_payload`] !== null) {
          const payload = await fileFingerprint(nativePath(journalRoot, entry[`${saved}_payload`]));
          if (payload.sha256 !== entry[`${saved}_sha256`] || payload.bytes !== entry[`${saved}_bytes`]) throw new Error("CMS recovery immutable payload is unavailable.");
        }
        const actual = await fileFingerprint(nativePath(nativeRoot, entry.path));
        observed.push({ path: entry.path, sha256: actual.sha256, before: actual.sha256 === entry.before_sha256,
          after: actual.sha256 === entry.after_sha256, matches: actual.sha256 === entry[`${side}_sha256`] });
      }
      await assertUnchanged(); return observed;
    };
    return await action({ snapshot: () => structuredClone(state), journalSha256: expected, assertUnchanged, snapshots,
      async archiveAndHandoff({ predecessorWorkId, successorWorkId, inspectionSha256, leaseGeneration }) {
        // This is deliberately separate from observation callers. It is reached
        // only after a positive receiver recovery instruction AND new lease.
        await assertUnchanged();
        if (!cmsUuid(predecessorWorkId) || !cmsUuid(successorWorkId) || predecessorWorkId === successorWorkId
            || !HASH.test(inspectionSha256) || !Number.isSafeInteger(leaseGeneration) || leaseGeneration <= (state?.last_lease_generation ?? 0)
            || !state?.transaction || state.transaction.authority.work_id !== predecessorWorkId || state.pending_mutation !== null
            || state.transaction.presentation_move && (!["committed", "aborted"].includes(state.transaction.presentation_move.phase) || state.transaction.presentation_move.baseline_pending)) throw new Error("CMS recovery handoff lacks exact successor authority.");
        const baseline = state.last_verified;
        const selected = baseline?.files ?? state.transaction.files;
        const observed = await snapshots(selected, baseline ? "after" : "before");
        if (observed.some((entry) => !entry.matches)) throw new Error("CMS recovery baseline changed before successor handoff.");
        const archive = Buffer.from(JSON.stringify({ schema_version: "db-hugo-attention-history-1", predecessor_work_id: predecessorWorkId,
          successor_work_id: successorWorkId, inspection_sha256: inspectionSha256, lease_generation: leaseGeneration, journal_sha256: expected, journal: state }) + "\n");
        const archiveFile = path.join(journalRoot, ".recovery", mappingId, `${predecessorWorkId}.json`);
        await immutablePayload(archiveFile, archive, digest(archive), archive.length); await assertUnchanged();
        const next = { ...state, transaction: baseline === null ? null : structuredClone(baseline) };
        // Keep the old durable fence/authority. The ordinary new lease entry is
        // the only allocator of the new active fence.
        await replaceRegular(file, Buffer.from(JSON.stringify(next) + "\n"), expected);
        return { predecessor_work_id: predecessorWorkId, successor_work_id: successorWorkId };
      },
      async restoreRecordedBaseline({ transactionId, operationId }) {
        await assertUnchanged();
        if (!cmsUuid(operationId) || !state?.transaction || state.transaction.transaction_id !== transactionId
            || state.pending_mutation !== null || state.transaction.phase === "verified" || state.transaction.presentation_move) throw new Error("CMS recorded baseline restore is not eligible.");
        const rows = await snapshots(state.transaction.files, "before");
        if (rows.some((entry) => !entry.before && !entry.after)) throw new Error("CMS recorded baseline restore refuses foreign native changes.");
        const operation = { schema_version: "db-hugo-baseline-restoration-1", operation_id: operationId, transaction_id: transactionId,
          mapping_id: mappingId, journal_sha256: expected, files: state.transaction.files };
        const operationFile = path.join(journalRoot, ".restorations", mappingId, `${operationId}.json`);
        const operationBytes = Buffer.from(JSON.stringify(operation) + "\n");
        await immutablePayload(operationFile, operationBytes, digest(operationBytes), operationBytes.length);
        for (const entry of state.transaction.files) {
          await assertUnchanged(); const target = nativePath(nativeRoot, entry.path), current = (await fileFingerprint(target)).sha256;
          if (current === entry.before_sha256) continue;
          if (current !== entry.after_sha256) throw new Error("CMS native content changed during baseline restore.");
          await replaceRegular(target, entry.before_payload === null ? null : { payloadFile: nativePath(journalRoot, entry.before_payload), sha256: entry.before_sha256 }, current);
        }
        const final = await snapshots(state.transaction.files, "before");
        if (final.some((entry) => !entry.matches)) throw new Error("CMS baseline restoration is incomplete.");
        const completed = Buffer.from(JSON.stringify({ ...operation, restored: true }) + "\n");
        await immutablePayload(operationFile.replace(/\.json$/u, ".completed.json"), completed, digest(completed), completed.length);
        return { operation_id: operationId, native_restored: true, public_restored: false };
      } });
  } finally { await osLock.release(); }
}

export async function withCmsJournalObservation(options, action) {
  return withCmsRecoveryJournal(options, ({ snapshot, journalSha256, assertUnchanged, snapshots }) => action({ snapshot, journalSha256, assertUnchanged, snapshots }));
}
export async function restoreCmsRecordedBaseline(options, operation) {
  return withCmsRecoveryJournal(options, (journal) => journal.restoreRecordedBaseline(operation));
}
export async function handoffCmsRecordedBaseline(options, recovery) {
  return withCmsRecoveryJournal(options, (journal) => journal.archiveAndHandoff(recovery));
}
