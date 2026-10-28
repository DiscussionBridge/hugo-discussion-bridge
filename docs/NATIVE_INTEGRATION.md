# Native Hugo consumer configuration

Keep config, connection secret, source ledger, journals/spool and lifecycle
census outside the native site and served output. To and From for one consumer
use the same private root/native content-root writer. The CLI reads an absolute
protected connectionSecretFile; raw connectionSecret in JSON/argv is rejected.
Only one optional final newline is removed from that file.

Example private JSON (operator-selected paths/executables are required):

```json
{
  "serverUrl": "https://forum.example",
  "connectionId": "dbc_0123456789abcdef01234567",
  "connectionSecretFile": "C:/BridgePrivate/site/connection.secret",
  "toNative": {
    "siteRoot": "C:/Sites/site",
    "command": {
      "executable": "C:/Tools/hugo.exe",
      "args": ["--source", "{site_root}", "--destination", "{public_root}", "--renderSegments", "discussionbridge-manifest"],
      "timeoutMs": 30000
    },
    "lifecycleCommand": {
      "executable": "C:/Tools/hugo.exe",
      "args": ["--source", "{site_root}", "--config", "hugo.toml,{capture_config}", "--destination", "{public_root}", "--renderSegments", "discussionbridge-source-lifecycle", "--buildDrafts", "--buildFuture", "--buildExpired"],
      "timeoutMs": 30000
    }
  },
  "native": {
    "siteRoot": "C:/Sites/site",
    "privateRoot": "C:/BridgePrivate/site",
    "siteUrl": "https://native.example",
    "nativeShortcode": "discussionbridge",
    "build": {
      "executable": "C:/Tools/hugo.exe",
      "args": ["--source", "{site_root}", "--destination", "{public_root}", "--cleanDestinationDir"],
      "timeoutMs": 30000
    },
    "deploy": {
      "executable": "C:/Tools/native-deploy.exe",
      "args": ["--input", "{public_root}", "--transaction", "{transaction_id}", "--receipt", "{receipt_path}"],
      "timeoutMs": 30000
    }
  }
}
```

The deploy executable is not supplied. The actual native deploy command writes
exactly deployment_id and deployed_at to the protected receipt path after actual
deployment. Mock/copy receipts are isolated fixture evidence only. Commands use
local structured argv/shell:false/hidden windows; no forum-selected shell command.
Successful argv execution is not anonymous public proof.

Private source captures retain the complete original rendered article together
with its captured article URL. To captures use the same native manifest's
`.Content` and `.Permalink`; From first verifies the complete immutable cooked
source and uses that source edition's `topic_url`. Relative copied links/images
are resolved against this captured source location within the existing safety
settings, before To complete-source evidence or native rendered-output evidence.
The destination URL never supplies the From article base. Original/capture files
remain private, including successful sources and local preparation limitations.

The installed consumer's native input/security policy still controls its build.
The isolated preparation fixture found Hugo0.165.0's default `security.allowContent`
excludes `text/html` content files; the integration does not override that policy.
Normal Markdown sources can be unformatted text or image-only. A native build or
preparation inability is an integration limitation, not a Bridge source-format
eligibility rule. No active-content/provider/URI/fallback recipe is selected here.

For a destination presentation move, supply the existing mapping UUID, exact
mapping revision and proposed native URL to `move-presentation`. The receiver
must already have authorized the current leased publication work. Native URL-only
admin work retains source/policy revisions; no fake native source edit is used.
Hugo's stored source-revision frontmatter remains the logical imported content
revision, while native file-byte CAS independently detects URL/metadata changes.
The page file/native ID, source article, resource and topic identities stay fixed.

The ordinary current-generation path uses21, real native move deployment and
owned nonce proof,22, then separate18 plus a fresh normal deployment/proof/19.
The move's public challenge is not a credential. It is rendered with move ID and
actual `.Page.Permalink` inside the adapter-owned fragment and compared with the
actual anonymous new-URL response. A standalone nonce elsewhere does not qualify.
An accepted URL move remains authoritative if later static settlement aborts;
native restoration uses that committed moved baseline, retaining historical
publication evidence separately. Applied/uncertain replacement-lease recovery
requires a concrete separately reconciled native mechanism and is not guessed.

Mount packaged layouts and dist browser assets through the existing Hugo module
mounts, keeping native list/single/archive/taxonomy templates. Add normal manifest:

```toml
[outputFormats.DiscussionBridge]
mediaType = "application/json"
baseName = "discussionbridge-manifest"
isPlainText = true
[outputs]
home = ["HTML", "DiscussionBridge"]
[segments.discussionbridge-manifest]
[[segments.discussionbridge-manifest.includes]]
output = "DiscussionBridge"
```

Private lifecycle output/flags belong only to temporary private capture config.
Never add them to ordinary public builds. Native opt-in uses
 discussionbridge_mode="to_discourse". authors may supply actual {id,name} source
provenance; they are not selected native-author assignment IDs. Native dates/
lastmod remain unknown when absent. Imported From pages keep the loop guard.

From verification checks actual canonical output without credentials/redirects
and matches the owned rendered fragment/identity/revision/mode; whole source
hash/count and native rendered hash remain separate. No metadata-sized universal
publication cap is imposed. Withdrawal requires actual public404/410. Installation
or package building does not run a live deployment.

Do not delete pending mutation/process evidence to make commands run again.
Reconcile actual effects first. Source-public move proof and concrete native-admin
retry remain unspecified; From proof/arbitrary markers cannot replace them.
