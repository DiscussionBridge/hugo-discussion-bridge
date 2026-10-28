# Native To source URL movement

This development implementation uses the existing To source engine and writer
for V4 routes28–31. It moves the URL of the same authored file, external/resource
identity and discussion. It does not use a From Work, lease or presentation
fragment as source-public proof. An operator must supply and qualify the actual
site template, routing and deployment integration below.

## Required native integration

The protected existing configuration adds `toNative.sourceMoves`:

| Field | Meaning |
|---|---|
| `profile` | Exact component-private `hugo-to-owned-full-article-1` |
| `dataRoot` | Absolute actual Hugo data directory within the configured site |
| `publicRoot` | Absolute actual build output within that site |
| `artifactPattern` | Actual output-file pattern, with optional `{url_path}` token |
| `inputs` | Nonempty array of actual routing, template and build-input filenames |
| `build`, `deploy` | Existing structured command objects: executable, args, timeoutMs |

Data, content, public output and private journal roots must be separated as
checked by the writer. Relative input filenames resolve against the actual site.
Include every selected native configuration/template/routing input needed to
reproduce the source article. The packaged source-article partial is also hashed.
This list is an explicit operator integration, not automatic dependency discovery.

The single-page template must call
`{{ partial "discussionbridge/source-article.html" . }}` at its article location.
The partial emits the title and complete prepared article inside its owned frame;
the selected template must account for that placement. Without owned move data it
renders the normal `.Content`. With owned data it renders the retained complete
prepared article, rather than reinterpreting relative targets against a new URL.
The normal private manifest capture independently renders actual `.Content`, and
the writer compares its preparation at the immutable captured article URL with
the entire accepted prepared article before generating owned data.

The data file is `discussionbridge_source_moves/<SHA256(native file path)>.json`
under `dataRoot`. It contains public article/identity/challenge data, never the
connection secret or private receipts. Do not expose the private state directory
through the site's publication roots. The partial binds current `.File.Path`,
authored-file SHA256, `.Permalink`, title and To mode. Its public nonce and markers
are necessary evidence; they are not sufficient without complete article equality.

The current native editor supports ordinary UTF8 Markdown files with TOML
frontmatter and a top-level unquoted lowercase `url` string scalar. It changes
or adds that scalar while preserving the article and unrelated authored bytes.
Unsupported frontmatter/custom route/encoding is an integration limit. Query
URLs are not represented by this editor. A native capture after the edit must
produce the exact requested `.Permalink`; no raw wire URL identity is normalized
to make a mismatch pass. `{url_path}` substitutes the native URL path without
leading/trailing slashes. For example, `{url_path}/index.html` is appropriate only
for a site actually producing those output files.

Build and deploy use the existing local command supervisor: structured argv,
`shell:false`, hidden Windows process, ignored stdout/stderr and durable process
intent/completion evidence. Supported argument tokens are `transaction_id`,
`site_root`, `public_root`, `receipt_path`, `source_file`, `source_url`, `move_id`.
The configured deploy operation must write its actual protected JSON receipt
`{"deployment_id":"...","deployed_at":"..."}` to `receipt_path`. Its time must
follow the actual completed build. An unknown/incomplete command is not rerun
merely because its process disappeared. No deploy provider or command is selected
by the forum or automatically installed by this component.

## Entry points and evidence

Run the existing protected CLI with actual config/manifest/private state and the
accepted page key:

```text
discussionbridge-hugo move-source --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
discussionbridge-hugo abort-source-move --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
discussionbridge-hugo source-status --state FILE
```

`moveSourceUrl` is the equivalent native API exported by `src/adapter.mjs`.
The source-state lock and shared native content writer/fence remain authoritative.
Current To connection, endpoint, secret, direction, lane, origin, owned active
record and accepted revision are revalidated. Historical From policy revision is
provenance, not a To authority gate. The actual current scope/config/input hashes
are frozen for the transaction and must remain stable during continuation.

Before28, the private journal saves exact old/new authored bytes, native rendered
snapshot, immutable02 birth capture, complete prepared article and actual current
receiver/native binding. A new move edition is saved once. After28 issues the
nonce, the writer performs the guarded authored-file edit, captures actual new
native output and saves the new native snapshot. Complete article hash/count,
title, authors, IDs and copied article targets stay fixed. Actual nullable dates
are captured; no edit time is invented. For generated excerpts, only the owned
Read More target changes; its historical selection facts remain intact.

The build output is checked against the entire independently retained prepared
article and identity/edition/file/nonce frame. Anonymous public verification GETs
the exact configured new URL with credentials omitted and redirects rejected.
It streams with a budget based on the actual expected complete built page, not
the metadata cap, then compares the whole owned frame byte-for-byte. Actual
verification time follows actual deployment. Full source hash and native rendered
frame hash have separate meanings.

Private receipt `db-hugo-to-source-receipt-1` binds connection/forum/site/content,
scope/lane, resource/topic/external/native-file identity, exact URL/edition,
authored SHA, complete source SHA/count/title/authors/actual dates, immutable
birth/native-before/native-after/prepared descriptors, native input/config digest,
public-data digest and issued challenge. Its digest is SHA256 of UTF8
`nativeSemanticJson(receipt)`: recursively sorted object keys, arrays in order,
no normalization or self-hash field. This is a component-private receipt, not a
new shared wire field or a claim that the receiver independently fetched Hugo.

## Continuation and abort

The journal progresses through exact28 intent/prepared, applying-file/applied-file,
fresh capture, applying-data/applied, built, deployed, verified, exact29 intent,
then committed. Before native mutation or HTTP, the relevant intent is durable.
An interrupted applying phase, foreign edit, changed input or uncertain process
stops for actual reconciliation. No replacement-writer recovery is fabricated.

Pending28/29/30 reuse their exact saved request. After uncertain29, current04 and
paged31 history can corroborate current ancestry, but cannot substitute an
acceptance receipt. Actual public state is rechecked and the exact29 obtains its
own response.31 is URL history, not a source-revision or mutation-receipt API.

Accepted29 is stored as its actual `Record`, separate from the immutable original
02 `ResolveResult`, request and capture birth URL. A private current-move pointer
selects the new current edition. An unchanged ordinary prepare uses that actual
observation without replaying old02 or inventing a ResolveResult. A genuine next
ordinary source edit uses29 as predecessor, then retires the owned public cache
by exact digest; prior02 and29 history remains immutable.05 uses the actual
current accepted revision.

An explicit unexecuted abort sends30 with `native_change_applied:false` only
after actual old ownership and absence of command effects are established. A
known applied mismatch or definitive29 preservation rejection may restore only
known owned before/after state using CAS, actual native capture, a new real
build/deploy and complete old-URL public proof.30 still says
`native_change_applied:true`: restoration does not erase the fact of a move.
Both reservations and source-move/To-record attention remain. Exact lost30 replay
rechecks actual current authorization and owned binding at the receiver before
returning its historical response; the caller does not invent a new active04
prerequisite for that historical replay. A fresh follow-up mutation cannot treat
the attention receipt as active. An uncertain29, unknown command,
foreign edit or missing ownership is not silently rolled back. Exact abort and
rejection evidence is retained; no automatic retry/new cycle is supplied.

## Current qualification limits

Isolated tests use actual Hugo/native files, a harmless configured copy child and
anonymous loopback transport seams. Those are not TLS/DNS/provider/live proof.
The first native suite recorded five Windows lock-helper startup failures. The
same five native paths later passed individually with unchanged lock protocol and
deadlines: full move/ancestry/next CAS/withdrawal, generated move/lost29 restart,
applied restoration/lost30 restart, definitive rejection/no-repeat, and foreign
file-edit refusal. The original startup failures remain unexplained; the separate
successful launcher probe does not establish their cause. Actual installed
site/template/routing, credentials,
deployment provider and public-host qualification remain required native inputs.
No release or formal review disposition is claimed.
