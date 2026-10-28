import { createHash, randomUUID } from "node:crypto";
import { lstat, open, opendir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assertCmsSafePath, createCmsPrivateDirectory, withCmsNativeLock } from "./cms-journal.mjs";
import { parseCmsJson, semanticIdentity, validateCms, validateCmsRoute } from "./protocol-v4/cms-runtime.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
async function regular(file) {
  await assertCmsSafePath(file);
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Hugo CMS private state is not a regular unlinked file."); return await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function withCmsContinuation({ privateRoot, nativeRoot, publicRoots, client, connection }, action) {
  if (!path.isAbsolute(privateRoot) || !Array.isArray(publicRoots) || !publicRoots.length) throw new Error("Hugo CMS protected continuation roots are required.");
  privateRoot = path.resolve(privateRoot);
  for (const root of [nativeRoot, ...publicRoots].map((root) => path.resolve(root))) {
    await assertCmsSafePath(root);
    if (contains(root, privateRoot) || contains(privateRoot, root)) throw new Error("Hugo CMS protected state must be disjoint from content and public output.");
  }
  await assertCmsSafePath(privateRoot);
  return withCmsNativeLock(path.join(privateRoot, ".continuation-lock"), async (assertHeld) => {
    const binding = { connection_id: connection.connection_id, forum_origin: client.origin, destination_origin: connection.destination_origin, scope_revision: connection.scope_revision, policy_revision: connection.policy.policy_revision };
    validateCms("Connection", connection);
    const stateFile = path.join(privateRoot, "continuation.json");
    const old = await regular(stateFile);
    let state = old === null ? { schema_version: "db-hugo-cms-continuation-1", binding, stream: "initial", next_cursor: null, checkpoint_cursor: null, last_sequence: null, last_initial_source: null, pending: null, active_lease: null, held_leases: [] }
      : parseCmsJson(old, { maximumBytes: 262144 });
    const stateKeys = ["schema_version", "binding", "stream", "next_cursor", "checkpoint_cursor", "last_sequence", "last_initial_source", "pending", "active_lease", "held_leases"];
    if (Object.keys(state).length !== stateKeys.length || stateKeys.some((key) => !Object.hasOwn(state, key))) throw new Error("Hugo CMS continuation fields need reconciliation.");
    if (state.schema_version !== "db-hugo-cms-continuation-1" || semanticIdentity(state.binding) !== semanticIdentity(binding)
        || !["initial", "changes"].includes(state.stream)) throw new Error("Hugo CMS continuation scope changed; mapping reconciliation is required.");
    for (const key of ["next_cursor", "checkpoint_cursor"]) if (state[key] !== null) validateCms("Cursor", state[key]);
    if (state.last_sequence !== null) validateCms("CoreId", state.last_sequence);
    if (state.last_initial_source !== null) validateCms("OpaqueId", state.last_initial_source);
    if (state.stream === "changes" && state.checkpoint_cursor === null) throw new Error("Hugo CMS change continuation lost its checkpoint; reconciliation is required.");
    if (!Array.isArray(state.held_leases) || state.held_leases.some((entry) => !entry || typeof entry !== "object" || Object.keys(entry).length !== 3
      || !Object.hasOwn(entry, "lease") || !Object.hasOwn(entry, "issue_name") || !["held", "resumed", "superseded"].includes(entry.state)
      || !/^native\/limitations\/[a-f0-9-]{36}\.json$/u.test(entry.issue_name))) throw new Error("Hugo CMS held local limitation ledger needs reconciliation.");
    if (state.pending !== null && (typeof state.pending !== "object" || Array.isArray(state.pending) || Object.keys(state.pending).length !== 5
        || ["route_id", "path", "body", "credential_sha256", "receipt"].some((key) => !Object.hasOwn(state.pending, key)))) throw new Error("Hugo CMS pending mutation fields need reconciliation.");
    let stateHash = old === null ? null : sha(old);
    async function replace(file, bytes, expectedHash) {
      await assertHeld(); await assertCmsSafePath(file);
      const before = await regular(file);
      if ((before === null ? null : sha(before)) !== expectedHash) throw new Error("Hugo CMS private state changed; reconciliation is required.");
      await createCmsPrivateDirectory(path.dirname(file));
      const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await assertHeld();
        const current = await regular(file);
        if ((current === null ? null : sha(current)) !== expectedHash) throw new Error("Hugo CMS private state changed before commit.");
        await rename(temp, file);
        if (process.platform !== "win32") { const dir = await open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); } }
      } finally { await rm(temp, { force: true }); }
    }
    const save = async () => { const bytes = Buffer.from(JSON.stringify(state) + "\n"); await replace(stateFile, bytes, stateHash); stateHash = sha(bytes); };
    const immutable = async (file, value) => {
      const bytes = Buffer.from(JSON.stringify(value)); const before = await regular(file);
      if (before !== null) {
        if (semanticIdentity(parseCmsJson(before, { maximumBytes: 262144 })) !== semanticIdentity(value)) throw new Error("Hugo CMS immutable source/event identity changed.");
      } else await replace(file, bytes, null);
    };
    const credential = async (token) => {
      validateCms("LeaseToken", token); const bytes = Buffer.from(token); const digest = sha(bytes);
      const file = path.join(privateRoot, "credentials", `${digest}.token`); const before = await regular(file);
      if (before === null) await replace(file, bytes, null);
      else if (sha(before) !== digest) throw new Error("Hugo CMS protected lease credential changed.");
      return digest;
    };
    const token = async (digest) => {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Hugo CMS protected credential identity is invalid.");
      const bytes = await regular(path.join(privateRoot, "credentials", `${digest}.token`));
      if (bytes === null || sha(bytes) !== digest) throw new Error("Hugo CMS original lease credential is unavailable; reconcile work status.");
      const value = bytes.toString("utf8"); validateCms("LeaseToken", value); return value;
    };
    const packLease = async (lease) => { validateCms("Lease", lease); const copy = structuredClone(lease); const digest = await credential(copy.lease_token); delete copy.lease_token; return { value: copy, credential_sha256: digest }; };
    const unpackLease = async (stored) => {
      if (!stored || typeof stored !== "object" || Object.keys(stored).length !== 2 || !Object.hasOwn(stored, "value") || !Object.hasOwn(stored, "credential_sha256")) throw new Error("Hugo CMS protected lease fields need reconciliation.");
      const value = { ...stored.value, lease_token: await token(stored.credential_sha256) }; return validateCms("Lease", value);
    };
    // Retained credentials and exact lease trees remain required recovery evidence.
    const retained = new Set();
    for (const entry of state.held_leases) {
      const lease = await unpackLease(entry.lease), key = `${lease.work.work_id}\0${lease.work.attempt_cycle}`;
      if (entry.issue_name !== `native/limitations/${lease.work.work_id}.json` || retained.has(key)) throw new Error("Hugo retained local lease identity needs reconciliation.");
      retained.add(key);
    }
    if (state.active_lease !== null) {
      const lease = await unpackLease(state.active_lease);
      if (state.held_leases.some((entry) => entry.state === "held" && entry.lease.value.work.work_id === lease.work.work_id)) throw new Error("Hugo active lease is also locally held.");
    }
    async function post(routeId, body, routePath = {}) {
      const input = structuredClone(body);
      input.mutation_id ??= state.pending?.route_id === routeId ? state.pending.body.mutation_id : randomUUID();
      validateCmsRoute(routeId, { body: input, path: routePath });
      let credentialSha = null;
      if (input.authority?.lease_token) { credentialSha = await credential(input.authority.lease_token); delete input.authority.lease_token; }
      const pending = { route_id: routeId, path: routePath, body: input, credential_sha256: credentialSha, receipt: null };
      if (state.pending === null) { state.pending = pending; await save(); }
      else if (semanticIdentity({ ...state.pending, receipt: null }) !== semanticIdentity(pending)) throw new Error("Hugo CMS uncertain mutation must replay its exact durable identity and payload.");
      if (state.pending.receipt === null) {
        const wireBody = structuredClone(input);
        if (credentialSha !== null) wireBody.authority.lease_token = await token(credentialSha);
        const response = await client.request(routeId, { body: wireBody, path: routePath });
        state.pending.receipt = response.value?.lease_token === undefined ? response : { status: response.status, lease: await packLease(response.value) };
        await save();
      }
      return state.pending.receipt.lease ? { status: state.pending.receipt.status, value: await unpackLease(state.pending.receipt.lease) } : structuredClone(state.pending.receipt);
    }
    const context = {
      snapshot: () => structuredClone(state), post,
      async resumeMutation() {
        if (state.pending === null) return null;
        const pending = structuredClone(state.pending), body = pending.body;
        if (pending.credential_sha256 !== null) body.authority.lease_token = await token(pending.credential_sha256);
        return { route: pending.route_id, body, response: await post(pending.route_id, body, pending.path) };
      },
      async *currentEvents() {
        const directory = path.join(privateRoot, "current"); await assertCmsSafePath(directory);
        let entries; try { entries = await opendir(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
        for await (const entry of entries) {
          if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error("Hugo CMS source census contains an unexpected entry.");
          const value = parseCmsJson(await regular(path.join(directory, entry.name)), { maximumBytes: 262144 }); validateCms("SourceEvent", value); yield value;
        }
      },
      async mapping(sourceId, value) {
        validateCms("OpaqueId", sourceId);
        const file = path.join(privateRoot, "mappings", `${sha(sourceId)}.json`); const bytes = await regular(file);
        const prior = bytes === null ? null : parseCmsJson(bytes, { maximumBytes: 262144 });
        if (prior !== null) validateCms("Mapping", prior);
        if (value === undefined) return prior;
        validateCms("Mapping", value);
        if (value.source_id !== sourceId || value.connection_id !== connection.connection_id
            || (prior !== null && ["mapping_id", "resource_id", "source_id", "external_id", "canonical_url"].some((key) => prior[key] !== value[key]))
            || (prior?.destination_native_id != null && prior.destination_native_id !== value.destination_native_id)) throw new Error("Hugo CMS mapping binding changed outside a controlled native move.");
        await replace(file, Buffer.from(JSON.stringify(value)), bytes === null ? null : sha(bytes)); return value;
      },
      async acceptPresentationMapping(move, value) {
        validateCms("UrlMove", move); validateCms("Mapping", value);
        const file = path.join(privateRoot, "mappings", `${sha(value.source_id)}.json`), bytes = await regular(file);
        if (bytes === null) throw new Error("Hugo presentation move has no owned mapping journal.");
        const prior = parseCmsJson(bytes, { maximumBytes: 262144 }); validateCms("Mapping", prior);
        if (["mapping_id", "resource_id", "connection_id", "source_id", "external_id", "destination_native_id"].some((key) => prior[key] !== value[key])
            || value.connection_id !== connection.connection_id || value.mapping_id !== move.mapping_id || value.canonical_url !== move.new_url
            || value.mapping_revision === move.expected_mapping_revision
            || (prior.canonical_url !== move.old_url || prior.mapping_revision !== move.expected_mapping_revision)
              && semanticIdentity(prior) !== semanticIdentity(value)) throw new Error("Hugo presentation move cannot replace an unrelated native binding.");
        await replace(file, Buffer.from(JSON.stringify(value)), sha(bytes)); return value;
      },
      async nativeRecord(name, value) {
        if (!/^native\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.json$/u.test(name)) throw new Error("Hugo CMS private native record name is invalid.");
        const file = path.join(privateRoot, ...name.split("/")); const bytes = await regular(file);
        if (value === undefined) return bytes === null ? null : parseCmsJson(bytes, { maximumBytes: 262144 });
        await replace(file, Buffer.from(JSON.stringify(value)), bytes === null ? null : sha(bytes)); return value;
      },
      async settleMutation() { if (state.pending === null || state.pending.receipt === null) throw new Error("Hugo CMS mutation has no durable successful receipt."); state.pending = null; await save(); },
      async holdLocalLimitation(lease, issueName) {
        validateCms("Lease", lease);
        if (!/^native\/limitations\/[a-f0-9-]{36}\.json$/u.test(issueName) || state.pending !== null || state.active_lease === null
            || semanticIdentity(await unpackLease(state.active_lease)) !== semanticIdentity(lease)) throw new Error("Hugo local limitation must retain its exact current lease.");
        const existing = state.held_leases.find((entry) => entry.lease.value.work.work_id === lease.work.work_id && entry.lease.value.work.attempt_cycle === lease.work.attempt_cycle);
        if (existing) throw new Error("Hugo exact local limitation lease is already retained.");
        state.held_leases.push({ lease: structuredClone(state.active_lease), issue_name: issueName, state: "held" });
        state.active_lease = null; await save(); // Receiver lease/count/time is untouched.
      },
      heldLimitations() { return structuredClone(state.held_leases.filter((entry) => entry.state === "held")); },
      async settleHeldLimitation(held, disposition) {
        if (!["resumed", "superseded"].includes(disposition)) throw new Error("Hugo held lease disposition needs reconciliation.");
        const existing = state.held_leases.find((entry) => semanticIdentity(entry.lease) === semanticIdentity(held.lease) && entry.issue_name === held.issue_name);
        if (!existing || existing.state !== "held") throw new Error("Hugo held original lease changed.");
        existing.state = disposition; await save();
      },
      async resumeHeldLease(held, current) {
        if (state.active_lease !== null || state.pending !== null) throw new Error("Hugo current active mutation prevents held lease resumption.");
        const lease = await unpackLease(held.lease);
        if (Date.parse(lease.expires_at) <= Date.now() || current.work.work_id !== lease.work.work_id || current.work.lease_generation !== lease.lease_generation
            || current.work.source_revision !== lease.work.source_revision || current.work.policy_revision !== lease.work.policy_revision
            || current.work.action !== lease.work.action || current.work.attempt_cycle !== lease.work.attempt_cycle
            || current.lease_expires_at === null || Date.parse(current.lease_expires_at) <= Date.now()) return false;
        state.active_lease = structuredClone(held.lease); await context.settleHeldLimitation(held, "resumed"); return true;
      },
      async claim(mappingId) {
        if (state.active_lease !== null) return unpackLease(state.active_lease);
        if (mappingId !== undefined) validateCms("UUID", mappingId);
        const result = await post("V4-13", mappingId === undefined ? {} : { mapping_id: mappingId });
        if (result.status === 204) { state.pending = null; await save(); return null; }
        state.active_lease = await packLease(result.value); state.pending = null; await save();
        return result.value;
      },
      async claimRecovery(recovery) {
        validateCms("AttentionRecovery", recovery);
        if (state.active_lease !== null) {
          const active = await unpackLease(state.active_lease);
          if (active.work.work_id !== recovery.work.work_id) return null;
          return active;
        }
        const result = await post("V4-36", { work_id: recovery.work.work_id }, { recovery_id: recovery.recovery_id });
        if (result.status === 204) { state.pending = null; await save(); return null; }
        if (result.value.work.work_id !== recovery.work.work_id || result.value.work.mapping_id !== recovery.mapping.mapping_id
            || result.value.work.attempt_cycle !== recovery.work.attempt_cycle) throw new Error("Hugo recovery claim returned a different Work.");
        state.active_lease = await packLease(result.value); state.pending = null; await save(); return result.value;
      },
      async *attentionRecoveries() {
        const queue = await context.nativeRecord("native/attention/queue.json") ?? { recovery_ids: [] };
        if (!Array.isArray(queue.recovery_ids) || queue.recovery_ids.length > 25 || new Set(queue.recovery_ids).size !== queue.recovery_ids.length) throw new Error("Hugo recovery queue is invalid.");
        for (const recoveryId of queue.recovery_ids) {
          validateCms("UUID", recoveryId);
          const value = await context.nativeRecord(`native/recoveries/${recoveryId}.json`);
          if (!value || value.recovery?.recovery_id !== recoveryId) throw new Error("Hugo recovery queue lost its durable instruction.");
          validateCms("AttentionRecovery", value.recovery);
          if (!["queued", "handed_off", "settled"].includes(value.state)) throw new Error("Hugo recovery continuation has an invalid state.");
          if (value.state !== "settled") yield value;
        }
      },
      async settleAttentionRecovery(record) {
        validateCms("AttentionRecovery", record.recovery);
        await context.nativeRecord(`native/recoveries/${record.recovery.recovery_id}.json`, { ...record, state: "settled" });
        const queue = await context.nativeRecord("native/attention/queue.json");
        if (!queue || !Array.isArray(queue.recovery_ids)) throw new Error("Hugo recovery queue is unavailable.");
        await context.nativeRecord("native/attention/queue.json", { recovery_ids: queue.recovery_ids.filter((id) => id !== record.recovery.recovery_id) });
      },
      async stageRecoverySource(recovery) {
        validateCms("AttentionRecovery", recovery);
        if (recovery.source !== null) await immutable(path.join(privateRoot, "sources", sha(recovery.source.source_id), `${sha(recovery.source.source_revision)}.json`), recovery.source);
        await context.mapping(recovery.mapping.source_id, recovery.mapping);
      },
      async renew(lease) {
        validateCms("Lease", lease);
        const authority = { work_id: lease.work.work_id, lease_token: lease.lease_token, lease_generation: lease.lease_generation, source_revision: lease.work.source_revision, policy_revision: lease.work.policy_revision };
        const result = await post("V4-15", { authority }, { work_id: lease.work.work_id });
        if (result.value.lease_token !== lease.lease_token || result.value.lease_generation !== lease.lease_generation || result.value.work.attempt !== lease.work.attempt
            || result.value.work.work_id !== lease.work.work_id || result.value.work.mapping_id !== lease.work.mapping_id || result.value.work.source_revision !== lease.work.source_revision || result.value.work.policy_revision !== lease.work.policy_revision) throw new Error("Hugo CMS renewal changed exact lease authority.");
        state.active_lease = await packLease(result.value); state.pending = null; await save(); return result.value;
      },
      async releaseCompletedLease(work) {
        validateCms("Work", work);
        const lease = state.active_lease === null ? null : await unpackLease(state.active_lease);
        if (state.pending !== null || !lease || work.work_id !== lease.work.work_id || work.mapping_id !== lease.work.mapping_id
            || work.lease_generation !== lease.lease_generation || !["verified", "attention", "superseded", "cancelled", "retry_wait"].includes(work.state)) throw new Error("Hugo CMS lease cannot be released without exact settled work status.");
        state.active_lease = null; await save();
      },
      async source(sourceId, revision) {
        validateCms("OpaqueId", sourceId); validateCms("Revision", revision);
        const bytes = await regular(path.join(privateRoot, "sources", sha(sourceId), `${sha(revision)}.json`));
        if (bytes === null) throw Object.assign(new Error("Hugo CMS claimed immutable source metadata has not been durably staged."), { code: "revision_unavailable" });
        const source = parseCmsJson(bytes, { maximumBytes: 262144 }); validateCms("Source", source);
        if (source.source_id !== sourceId || source.source_revision !== revision) throw new Error("Hugo CMS staged source binding is invalid.");
        return source;
      },
      async drainSources({ maximumPages = 10, beforePage = async () => {} } = {}) {
        if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 100) throw new Error("Hugo CMS feed page budget is invalid.");
        for (let page = 0; page < maximumPages; page++) {
          await beforePage();
          const stream = state.stream, cursor = state.next_cursor ?? (stream === "changes" ? state.checkpoint_cursor : null);
          if (stream === "changes" && cursor === null) throw new Error("Hugo CMS change feed requires its durable checkpoint.");
          const { value: feed } = await client.request("V4-06", { query: { stream, ...(cursor === null ? {} : { cursor }) } });
          if (feed.stream !== stream || (feed.next_cursor !== null && feed.next_cursor === cursor)) throw new Error("Hugo CMS source continuation did not advance.");
          let lastSequence = state.last_sequence, lastInitial = state.last_initial_source;
          for (const entry of feed.items) {
            if (stream === "changes" && lastSequence !== null && BigInt(entry.event_sequence) <= BigInt(lastSequence)) throw new Error("Hugo CMS change events are not strictly increasing.");
            if (stream === "initial") {
              if (entry.event_type !== "publication" || (lastInitial !== null && Buffer.compare(Buffer.from(entry.source.source_id), Buffer.from(lastInitial)) <= 0)) throw new Error("Hugo CMS initial source ordering is invalid.");
              lastInitial = entry.source.source_id;
            } else lastSequence = entry.event_sequence;
            await immutable(path.join(privateRoot, "events", `${entry.event_id}.json`), entry);
            if (entry.event_type === "publication") await immutable(path.join(privateRoot, "sources", sha(entry.source.source_id), `${sha(entry.source.source_revision)}.json`), entry.source);
            const sourceId = entry.event_type === "publication" ? entry.source.source_id : entry.source_id;
            const currentFile = path.join(privateRoot, "current", `${sha(sourceId)}.json`), before = await regular(currentFile);
            await replace(currentFile, Buffer.from(JSON.stringify(entry)), before === null ? null : sha(before));
          }
          state.last_sequence = lastSequence; state.last_initial_source = lastInitial; state.next_cursor = feed.next_cursor;
          if (feed.checkpoint_cursor !== null) state.checkpoint_cursor = feed.checkpoint_cursor;
          if (stream === "initial" && feed.next_cursor === null) state.stream = "changes";
          await save(); // Every entry is durable before either continuation/checkpoint advances.
          if (feed.next_cursor === null) return { complete: true, pages: page + 1 };
        }
        return { complete: false, pages: maximumPages };
      },
    };
    return action(context);
  });
}
