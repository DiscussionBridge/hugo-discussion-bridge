# Hugo DiscussionBridge V4

Unpublished development **0.4.0-alpha.1**, wire **v4**, candidate
`discussionbridge-v4-core-20261025-r6`, release version `null`. The additive
attention-recovery-1 capability is probed before its new routes are used;
existing V4-01..31 shapes stay unchanged. Explicit V4 private journal and source
creation provenance remains intact, including known r5 records; no old wire
selector, silent retagging or legacy initialization is included. No native deployment,
release or formal review qualification is claimed.

## Development checks

Run `npm ci`, `npm test` and `npm run build` from this checkout. The complete
test entry point requires the native `hugo` executable on PATH (CI uses the
already-tested extended 0.165.0 release) and Ruby for one shared-plugin
evaluator fixture. Set `DISCUSSIONBRIDGE_RUBY_BINARY` if Ruby is not on PATH.
Set `DISCUSSIONBRIDGE_TEST_PLUGIN_ROOT` to the matching shared-plugin checkout;
by default the fixture uses a sibling `discourse-plugin` directory. CI checks
out that peer at an explicit commit. The evaluator fixture does not run
Discourse, Rails or PostgreSQL and does not replace installed integration
qualification. Its synthetic files/evidence stay in this checkout's `.tmp`.

CI runs the complete tests on Node 22 and 24, builds the ordinary browser
assets, creates the normal `npm pack` artifact, then installs that artifact in
an isolated consumer and checks both public imports. No sandbox credential,
receiver installation, public deployment or live publication is used by those
checks.

## Native commands

The package includes layouts/shortcode, browser assets and the private typed
runtime. Configure the native mounts/output in docs/NATIVE_INTEGRATION.md.
Server commands require Node22+ and the existing configured Hugo executable.

```text
discussionbridge-hugo prepare --config FILE --manifest FILE --output FILE --state FILE
discussionbridge-hugo retry-source --config FILE --manifest FILE --output FILE --state FILE --key PAGE --refused-mutation UUID
discussionbridge-hugo sync-publications --config FILE
discussionbridge-hugo check-attention --config FILE
discussionbridge-hugo restore-baseline --config FILE --mapping UUID --transaction UUID --operation UUID
discussionbridge-hugo deploy-restored-baseline --config FILE --mapping UUID --transaction UUID --operation UUID
discussionbridge-hugo move-presentation --config FILE --mapping UUID --mapping-revision REVISION --new-url HTTPS_URL
discussionbridge-hugo source-status --state FILE
discussionbridge-hugo prepare-public --config FILE --manifest FILE --output FILE
discussionbridge-hugo move-source --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
discussionbridge-hugo abort-source-move --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
```

`prepare` captures actual eligible sources into private output, rechecks their
native file hashes and uses one To writer. It retains original rendered article
bytes together with the captured source article URL in private immutable capture
descriptors. Supported copied relative links/images are resolved against that
captured URL through the existing sanitizer, before whole prepared HTML is hashed/count
measured before generated excerpt selection. The exact request, opaque revision
and predecessor are durable before dispatch; uncertain requests replay unchanged.
Actual source dates/authors stay distinct from delivery/proof time. Topic IDs
remain decimal strings. Resource/topic/external identities and history persist.
The private lifecycle command can capture draft/future/expired eligibility
without adding all-content flags or private metadata to ordinary public output.
Actual accepted deletion, unpublication and opt-out can withdraw the binding;
uncertain withdrawal retains its original reason/predecessor. It never causes an
automatic republish. No policy-excluded reason is inferred without a classifier.

`sync-publications` consumes authorized From work and complete immutable source
chunks. It first verifies the entire source bytes/hash/UTF-8, retaining those
original bytes with the edition-captured `Source.topic_url`. Native preparation
then resolves supported copied references against that source article URL;
original source integrity and rendered native-output evidence remain separate.
A native transaction stages/applies files, prepares, runs operator-local
build/deploy argv, reads the actual deployment receipt, anonymously verifies the
action-matching canonical output, then finalizes. Prepare/deploy alone is not
publication completion. Ownership, prior native bytes, generation, exact
mutations and process receipts support restoration/recovery. Unknown command
effects require reconciliation before another execution.

`check-attention` reads the forum-selected inspection requests and observes
actual complete native manifests, immutable payloads, ownership/revision,
command/pending state and supported public baseline proof under the existing
writer locks. It stages/replays only its diagnostic reports and recovery
instructions. It never claims publication work, repairs/restores files, renews
an old lease, builds or deploys. Administrators must explicitly choose individual
or selected-bulk Retry in the forum after checking. Metadata returning or a
successful check does not start a new cycle.

`sync-publications` also consumes those instructions. An explicitly admitted
successor is discovered even when the source revision/feed is unchanged, then
claimed through the exact recovery route. Native state is rechecked under that
new lease before an immutable archive of the old failed journal and a narrow
baseline handoff; the ordinary writer advances the fence. Native/resource/topic
identity, old failure/history, pending evidence and original captures survive.

`restore-baseline` is a separate local-owner command for one exact retained
transaction, not an effect of Check or a remote forum command. It refuses
foreign/unknown operations and durably journals the exact operation before CAS
restoration. It preserves the failed journal and reports native restoration
only. `deploy-restored-baseline` separately authorizes configured baseline
build/deploy commands after proving that restoration is complete; its distinct
command receipts survive interruptions. A fresh Check must still prove the
native/public baseline before the forum's disclosed Settle restored baseline
and retry operation. Applied static-candidate adoption, missing old proof,
unresolved commands/mutations and applied URL rebind remain blocked.

`move-presentation` uses the same From writer, protected continuation, native
file journal and configured build/deploy commands. It claims only existing
authorized work for the named mapping; an unchanged-source URL-only cycle must
already have been created by the native administrator's audited receiver flow.
The caller does not create work, reset attempts or invent a source/policy edition.
It validates the current mapping revision and actual owned file hashes, moves
the same native page object, and observes the receiver-issued public nonce,
native identity and actual canonical permalink inside the owned rendered
fragment. The source article and all discussion identities remain unchanged.

Move21 reserves the proposal; actual native build/deploy/public proof precedes
URL finalize22. Only then does static prepare18 run, followed by a fresh native
build/deploy/public proof and static finalize19. URL finalization alone does not
settle publication. The journal preserves the previous publication receipt and
the separate committed native move baseline until ordinary publication settles.
Uncertain21/22/23 mutations replay their exact durable request and credential
reference. They do not allocate a replacement mutation or hide uncertainty by
rolling files back.

An actual new-URL public mismatch under still-current authority restores the
owned old native files, runs the real old build/deploy/public check, and reports
an applied abort23. Both reservations remain even after that restoration.
Only the defined actual public-verification failure is then reported through17;
the abort itself is not a work-attention acknowledgement. A source/generation
race or applied move under replacement authority stays explicit native
reconciliation with journal/reservations retained. No automatic rebind, retry,
new cycle, cross-origin move or arbitrary topic rebind is provided.

The shortcode retains native Core/Simple/Full/Interactive interfaces.
`prepare-public` uses credential-free public Core reads where needed and requires
no Content Connection. Browser artifacts contain no protected credentials.
Connected rendering uses the authoritative effective connection forum label.

## Content preservation and explicit limits

Carried native preparation helpers are implementation behavior, not a newly
selected universal SourceHTML/provider/URI/rich-default recipe.
Preparation may normalize markup or convert native content to a safe portable
equivalent when meaning is preserved. The whole prepared article is hashed and
counted before excerpting; the native original stays intact. Exact URI/media/
acceptable-fallback limits remain unselected.
Unformatted text and non-text content are not rejected because of their format.
Plain text and image-only sources use the same native path. Preparation inability
is a local Bridge limitation, rather than proof that the source is invalid or
absent. The existing sanitizer's safety restrictions are unchanged; an observed
removed copied target is recorded explicitly instead of a silent full-success
claim. Resolving a relative reference does not enable a scheme or player.
An actual parsed script or event handler removed by current preparation is also
reported specifically through the local limitation path. Escaped displayed code
and comments are not treated as executable markup; removed JSON data scripts are
identified as data loss, without claiming function execution. Unknown script
types are reported as removed script elements. No execution permission/ban or
faithful component binding is inferred. Original retention does not make a
nonfunctional copy equivalent; the unresolved function is left for the operator's
decision where existing supported handling cannot preserve it.
The existing `source-status`/`prepare` local status includes each source's recorded
removed structure/handler/target, captured article URL and private descriptor
reference. It does not expose the original program body in status output or
create a receiver Failure/operator control.
Canonical-only source movement compares against the accepted capture's source
base; it does not rebase accepted article bytes against the proposed URL.
Some meaningful player/embed inputs currently lose markup in that helper. Actual detected loss
preserves the whole pinned source/prior output privately and stops that lossy
mutation locally, without fabricating receiver Failure, attention or full-success
ACK. It does not establish that Hugo cannot represent video/rich content.

From issues identify exact Work/action/source/policy/cycle/cause and retain the
original lease credential reference. The scheduler does not repeatedly claim or
renew the same known lossy intent. Other owned mappings use the existing positive
mapping_id claim. Supersession/revocation or faithful repair triggers
reconciliation. Where the declared API cannot distinguish another work within a
held mapping, results expose within_mapping_work_selection_unresolved. No global
or permanent mapping/manual barrier is introduced. Actual central attention still
requires its checked native-admin retry mechanism, which is not invented here.

`move-source` uses the same To source writer, authored file and durable journal
for routes28–31. Its explicitly configured native full-article template, actual
build/deploy receipt and anonymous complete-article proof are described in
[docs/TO_SOURCE_MOVES.md](docs/TO_SOURCE_MOVES.md). Pure generated Read More
projection alone is insufficient. Missing installed routing/template/deployment
inputs stop the local operation. Native selected author/taxonomy repository ID
assignment is separately undefined; nonempty From selections stop before claim,
while empty selections preserve defaults/current assignments.

New private source ledgers and native writer bindings carry explicit V4 wire/state
identity separately from immutable creation-artifact provenance. Current requests,
scope and CAS are validated by the one active codec. Existing files without that
explicit identity stop for native reconciliation and remain unchanged; no older
development-state retagging, decoder registry or automatic conversion is supplied.

A validated To `content_preservation_unavailable` HTTP422 retains its exact
request, private capture and rejection outcome durably. Normal builds and restarts
do not retransmit that rejected snapshot; status exposes the safe code in
`rejected_to_intents`. Other eligible sources continue. A genuinely changed
current ordinary snapshot, including a native title/authorship/actual-date edit
with the same article body, can form a fresh request under current scope and the
actual accepted predecessor/CAS. The rejected request/history stays immutable;
this does not assert receiver repair. Receiver-only repair of an identical full
snapshot has no declared readiness action here. Transport-uncertain requests keep
their existing exact replay. Native source closure still uses the accepted To05
binding without replaying its rejected update. A definitive29 rejection retains
its exact request/outcome and, where actual owned state permits restoration,
records a truthful applied abort with both URL reservations retained.

For a definitive To02 `invalid_field` HTTP422 refusal, `source-status` also shows
the refused mutation UUID and whether decoded diagnostics were retained. After
correcting its actual cause, an operator can explicitly use `retry-source` with
that UUID through the same protected local CLI/configuration. The command
recaptures current published opted-in source, checks both writer fences/current
To authority and actual predecessor/CAS or creation collisions, then atomically
retains refusal history, actual OS caller/process/action lineage and one linked
replacement request before dispatch. Only its mutation UUID changes: the refused
source revision, dates and payload are retained. Missing historical diagnostics
remain UNKNOWN. There is no witness-import or repair-attestation command.

A stale invocation names its original refused UUID; it cannot retry a later
refusal. An uncertain linked replacement keeps its exact new UUID/request through
ordinary reconciliation, and another definitive refusal stops again. Normal
`prepare` does not create these operator actions or retry unchanged refusals.
Genuinely changed ordinary source editions retain their normal path. To29 and
From retry rules are unchanged. This recovery source and its focused fixtures
await execution; it has no inherited native/package/canary qualification.

## Private exact artifacts

src/protocol-v4/PROVENANCE.json records unchanged portable artifacts:

| Artifact | Bytes | SHA256 |
|---|---:|---|
| cms-schema.json | 115670 | 8563a9b1346e3bf82635bd65a46bb1e25415a1003d7432f8fcb8c1c6e4f03c14 |
| cms-runtime.mjs | 35144 | e1790fd800abcae9772d327625ea188f04ec68c63ce7917cb0785f5cdea22538 |

Current implementation checks are recorded separately in the successor map.
Contract reproduction and earlier Hugo results do not qualify a changed native
consumer/deployment. Normal dependencies are declared; local test/build runtime
reuse and successor reports are not shipped.
