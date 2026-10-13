import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CMS_OWNERSHIP_FIELDS, hashCmsOwnershipReceipt, serializeCmsOwnershipReceipt } from "../src/cms-ownership.mjs";

const receipt = {
  schema_version: "db-native-ownership-1", forum_origin: "https://forum.example/", connection_id: `dbc_${"a".repeat(24)}`,
  mapping_id: "11111111-1111-4111-8111-111111111111", resource_id: "22222222-2222-4222-8222-222222222222",
  source_id: "source-é", external_id: "native/external:1", native_id: "article.md", canonical_url: "https://native.example/article/",
  source_revision: "revision-1", last_lease_generation: 7, move_id: null, proof_nonce: null,
};

test("approved ownership byte framing is independent of object order and counts UTF-8 bytes", () => {
  const bytes = serializeCmsOwnershipReceipt(receipt);
  let offset = 0;
  const values = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    values.push(length === 0xffffffff ? null : bytes.subarray(offset, offset + length).toString("utf8"));
    if (length !== 0xffffffff) offset += length;
  }
  assert.deepEqual(values, CMS_OWNERSHIP_FIELDS.map((field) => receipt[field] === null ? null : String(receipt[field])));
  assert.equal(offset, bytes.length);
  const reversed = Object.fromEntries(Object.entries(receipt).reverse());
  assert.deepEqual(serializeCmsOwnershipReceipt(reversed), bytes);
  assert.equal(hashCmsOwnershipReceipt(receipt), createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(hashCmsOwnershipReceipt(receipt), hashCmsOwnershipReceipt({ ...receipt, last_lease_generation: 8 }));
});

test("receipt rejects credential fields, missing nullable fields, coerced counters and URL ambiguity", () => {
  for (const changed of [
    { ...receipt, lease_token: "secret" }, { ...receipt, move_id: undefined },
    { ...receipt, last_lease_generation: "7" }, { ...receipt, last_lease_generation: -0 },
    { ...receipt, source_revision: "  " }, { ...receipt, canonical_url: "https://native.example/a/%2e%2e/b/" },
    { ...receipt, canonical_url: "https://native.example/a/#" }, { ...receipt, forum_origin: "https://forum.example/path/" },
  ]) assert.throws(() => serializeCmsOwnershipReceipt(changed), /receipt/u);
  const missing = { ...receipt }; delete missing.proof_nonce;
  assert.throws(() => serializeCmsOwnershipReceipt(missing), /receipt/u);
});
