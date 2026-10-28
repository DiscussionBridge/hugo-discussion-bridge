import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import path from "node:path";
import { readRegular, syncDirectory } from "./native-io.mjs";
import { assertCmsSafePath, withCmsNativeLock } from "./native-lock.mjs";
import { candidateId, cmsSchemaIdentity, validateCms, semanticIdentity } from "./protocol-v4/cms-runtime.mjs";

// One current native content-root writer. Local format1 is not wirev1.
export async function withHugoNativeWriter({ nativeRoot, connection, forumOrigin, privateRoot, observeOnly = false }, action) {
  nativeRoot = path.resolve(nativeRoot);
  validateCms("Connection", connection); validateCms("Url", forumOrigin);
  if (connection.profile !== "hugo") throw new Error("Hugo native V4 authority is unavailable.");
  const lockRoot = path.join(nativeRoot, ".discussionbridge-writer");
  const authorityFile = path.join(lockRoot, "authority.json");
  await assertCmsSafePath(authorityFile);
  return withCmsNativeLock(lockRoot, async (assertHeld) => {
    await assertHeld();
    const bytes = await readRegular(authorityFile);
    const expected = { schema_version: "db-hugo-native-writer-1", wire_version: "v4", candidate_id: candidateId, schema_sha256: cmsSchemaIdentity.sha256,
      connection_id: connection.connection_id, forum_origin: forumOrigin,
      ...(privateRoot === undefined ? {} : { private_root: path.resolve(privateRoot) }) };
    if (bytes !== null) {
      let saved; try { saved = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Hugo native writer authority needs reconciliation."); }
      if (!Object.hasOwn(saved, "wire_version")) throw Object.assign(new Error("Hugo native writer lacks explicit V4 wire identity; preserve it for reconciliation without automatic retagging."), { code: "native_state_identity_unavailable" });
      validateCms("OpaqueId", saved.candidate_id); validateCms("Sha256", saved.schema_sha256);
      const scope = ({ candidate_id, schema_sha256, ...binding }) => binding;
      if (semanticIdentity(scope(saved)) !== semanticIdentity(scope(expected))) throw new Error("Hugo native writer binding changed; reconciliation is required.");
    } else if (!observeOnly) {
      const temp = path.join(lockRoot, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(expected) + "\n"); await file.sync(); } finally { await file.close(); }
        await assertHeld();
        if (await readRegular(authorityFile) !== null) throw new Error("Hugo native writer authority changed.");
        await link(temp, authorityFile); await syncDirectory(lockRoot);
      } finally { await rm(temp, { force: true }); }
    }
    return action(assertHeld);
  });
}
