import { createHash } from "node:crypto";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";

export const CMS_OWNERSHIP_FIELDS = Object.freeze([
  "schema_version", "forum_origin", "connection_id", "mapping_id", "resource_id",
  "source_id", "external_id", "native_id", "canonical_url", "source_revision",
  "last_lease_generation", "move_id", "proof_nonce",
]);

export function cmsUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}

export function cmsOpaque(value, maximum = 255) {
  try { validateCms("OpaqueId", value); return Buffer.byteLength(value, "utf8") <= maximum; } catch { return false; }
}

export function cmsUrl(value) {
  try { validateCms("Url", value); return true; } catch { return false; }
}

export function validateCmsOwnershipReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.keys(receipt).length !== CMS_OWNERSHIP_FIELDS.length
      || CMS_OWNERSHIP_FIELDS.some((field) => !Object.hasOwn(receipt, field))) throw new Error("CMS ownership receipt has invalid fields.");
  if (receipt.schema_version !== "db-native-ownership-1" || !cmsUrl(receipt.forum_origin)
      || new URL(receipt.forum_origin).pathname !== "/" || new URL(receipt.forum_origin).search
      || !/^dbc_[a-f0-9]{24}$/u.test(receipt.connection_id)
      || !cmsUuid(receipt.resource_id) || (receipt.mapping_id !== null && !cmsUuid(receipt.mapping_id))
      || (receipt.move_id !== null && !cmsUuid(receipt.move_id)) || !cmsUrl(receipt.canonical_url)
      || !["source_id", "external_id", "native_id"].every((field) => cmsOpaque(receipt[field]))
      || (receipt.source_revision !== null && !cmsOpaque(receipt.source_revision, 128))
      || !Number.isSafeInteger(receipt.last_lease_generation) || Object.is(receipt.last_lease_generation, -0)
      || receipt.last_lease_generation < 0
      || (receipt.proof_nonce !== null && !cmsCanonicalToken(receipt.proof_nonce))) throw new Error("CMS ownership receipt is invalid.");
  return receipt;
}

export function cmsCanonicalToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value)
    && Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function serializeCmsOwnershipReceipt(receipt) {
  validateCmsOwnershipReceipt(receipt);
  const chunks = [];
  for (const field of CMS_OWNERSHIP_FIELDS) {
    const value = receipt[field];
    const bytes = value === null ? null : Buffer.from(String(value), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes === null ? 0xffffffff : bytes.length);
    chunks.push(length);
    if (bytes !== null) chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function hashCmsOwnershipReceipt(receipt) {
  return createHash("sha256").update(serializeCmsOwnershipReceipt(receipt)).digest("hex");
}
