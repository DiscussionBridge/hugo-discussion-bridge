import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Bundled license source is not an unlinked file");
  const bytes = fs.readFileSync(file);
  if (!bytes.toString("utf8").trim()) throw new Error("Bundled license source is empty");
  return bytes;
}

export function bundledLicense(directory, metadata) {
  const name = fs.readdirSync(directory).sort().find(file => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(file));
  if (name) {
    const bytes = regular(path.join(directory, name));
    return { bytes, licenseSource: { file: name, bytes: bytes.length, sha256: hash(bytes), extraction: "whole-file" } };
  }
  // This exact published version puts its complete terms in README rather
  // than a standalone LICENSE. Preserve that actual section, not an invented
  // MIT template or a package-metadata label substituted for permission text.
  if (metadata.name === "fastdom" && metadata.version === "1.0.12" && metadata.license === "MIT") {
    const source = regular(path.join(directory, "README.md"));
    if (hash(source) !== "cc5669ab6f7741bb061c8a7244addc8e3af1f84ec7d2445744b59d0169a87d11") throw new Error("Unexpected FastDom README license source");
    const text = source.toString("utf8");
    const marker = "## License\n";
    if (text.split(marker).length !== 2) throw new Error("Ambiguous FastDom license section");
    const bytes = Buffer.from(text.slice(text.indexOf(marker)).trimEnd() + "\n");
    if (bytes.length !== 1106 || hash(bytes) !== "df2ae14f12f31864acef768195afe4584b08a257f25925f49884619279f02f37") throw new Error("Incomplete FastDom license section");
    return { bytes, licenseSource: { file: "README.md", bytes: source.length, sha256: hash(source), extraction: "pinned-license-section" } };
  }
  throw new Error(`Required bundled license unavailable: ${metadata.name}@${metadata.version}`);
}
