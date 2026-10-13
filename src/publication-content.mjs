import { createHash } from "node:crypto";

export const PUBLICATION_CONTRACT = "0.3.0-alpha.1";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashValue = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export class SourceChanged extends Error {}

export async function hydratePublication(record, getChunk, cached) {
  const content = record.source?.content;
  if (!content) return record.content_html;
  const edition = record.source.edition;
  if (!hashValue(edition) || !hashValue(content.sha256) || !Number.isSafeInteger(content.bytes) || content.bytes < 1 || content.chunk_bytes !== 32768 || content.path !== `/discussion-bridge/v1/bridge-records/${record.resource_id}/content.json`) throw new Error("Hugo source content descriptor is invalid.");
  if (cached?.source_edition === edition && cached.content_sha256 === content.sha256 && hashValue(cached.sanitized_content_sha256) && typeof cached.content_html === "string" && digest(Buffer.from(cached.content_html, "utf8")) === cached.sanitized_content_sha256) return cached.content_html;
  const chunks = []; const hash = createHash("sha256"); let offset = 0;
  for (;;) {
    const response = await getChunk(`${content.path}?edition=${edition}&offset=${offset}`);
    if (response.status === 409) throw new SourceChanged("Hugo source changed during transfer; synchronize and retry.");
    const payload = response.payload;
    if (!response.ok || !payload || payload.resource_id !== record.resource_id || payload.edition !== edition || payload.offset !== offset || payload.total_bytes !== content.bytes || payload.content_sha256 !== content.sha256 || typeof payload.chunk_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload.chunk_base64)) throw new Error("Hugo source content chunk identity is invalid.");
    const bytes = Buffer.from(payload.chunk_base64, "base64");
    const next = offset + bytes.length;
    if (!bytes.length || bytes.length > content.chunk_bytes || next > content.bytes || bytes.toString("base64") !== payload.chunk_base64 || (next === content.bytes ? payload.next_offset !== null : payload.next_offset !== next)) throw new Error("Hugo source content chunk offset is invalid.");
    chunks.push(bytes); hash.update(bytes); offset = next;
    if (payload.next_offset === null) break;
  }
  if (hash.digest("hex") !== content.sha256) throw new Error("Hugo source content digest is invalid.");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, content.bytes));
}
