# Install the Hugo adapter

Use Node 22 or newer and one immutable adapter commit or verified package. This
component currently uses `/discussion-bridge/v1/bridge-records` on the forum;
the dormant V2 proposal modules are not part of the installed runtime. No new
release identity is established by this guide.

For a source checkout, detach at the selected full release commit and use its
locked dependencies with `npm ci --ignore-scripts` and an explicitly chosen
cache. Build both browser bundles with `npm run build` before packing. Source,
locked dependencies and the build script are included in the package.
The package carries `npm-shrinkwrap.json`; its dependency graph matches the
source checkout's lockfile. Production installation uses the shipped bundles;
rebuilding from source requires the locked development dependencies.

Install the verified package in the Hugo project's normal npm dependencies:

```sh
npm install --save-exact --ignore-scripts /absolute/path/to/verified-adapter.tgz
```

Retain the consumer's lockfile and artifact integrity. The installed module
contains the CLI, native adapter, reusable layouts and two browser bundles.
It excludes tests, test helpers, caches and proposal code. Both files under
`dist/` are packaged presentation capabilities, not disposable build caches.
Activate only the assets selected for the site's integration.

The supplied templates are optional package capabilities. npm installation does
not copy them into a site, modify a theme or activate Hugo mounts. An operator
may supply its own manifest and presentation integration instead.

To use the supplied integration, explicitly merge the selected settings from
[hugo-mounts.toml.example](hugo-mounts.toml.example) into the site's existing
Hugo configuration. Supply its real HTTPS forum origin. Preserve existing
site/theme output formats and mounts. Hugo's [mount documentation](https://gohugo.io/configuration/module/#mounts)
explains that a component's default mount must be included when adding mounts
for that component. The example retains the site's `layouts` and `static`
directories and mounts the package's templates and Simple browser asset.
When using these mounts, no site-local copy of the DiscussionBridge shortcode
or demo wrapper is needed. Site-owned templates remain under operator control;
the adapter never overwrites them.

## Optional rich-content rendering

Rich rendering is a separate choice from selecting the packaged templates or
the Simple/Full/Interactive discussion mode. The supplied shortcode keeps
`params.discussionbridge_rich_content` off by default. To enable the packaged
Mermaid and mathematics renderer, set that parameter to boolean `true` and explicitly add
[hugo-rich-content.toml.example](hugo-rich-content.toml.example)'s asset mount.
To disable it, set the parameter to `false` and omit that optional mount. Do not
change the discussion mode to make this choice. An operator-owned integration
may load its own selected rich renderer instead.

## Page configuration and build order

The packaged manifest uses existing page frontmatter: `discussionbridge_mode`,
optional `discussionbridge_topic_id` or `discussionbridge_resource_id`, source
`authors`, and `discussionbridge_primary_author_id`. Each manifest key is the
page's content basename. Basenames must be unique across opted-in pages; the
adapter rejects duplicate keys before any request. Site configuration and the
manifest contain no connection secret.

The manifest direction selectors `to_discourse` and `from_discourse` differ
from the shortcode's presentation selectors `simple`, `full` and `interactive`.
A Hugo-authored page can use `discussionbridge_mode = "to_discourse"` with
`{{< discussionbridge mode="interactive" >}}`. A received article uses
`discussionbridge_mode = "from_discourse"` and
`{{< discussionbridge mode="from_discourse" >}}`. That shortcode renders the
sanitized prepared article and requests the core's comments-only source
presentation for its Interactive discussion. The forum still verifies the
mapping and its Interactive configuration. Canonical modes are
required; legacy aliases and unknown shortcode modes fail the Hugo build.

An explicitly authorized native publication is created by the existing
`sync-publications` command, which requires `native_materialization` on an
active presentation binding. Installing templates or showing a registered
article does not grant that authority.

New native pages also require the site's positive local handler choice.
Set `DISCUSSIONBRIDGE_HUGO_NATIVE_SHORTCODE=discussionbridge` only after choosing
the packaged mounts or an existing site-owned handler of that name. An existing
equivalent shortcode may use its own selected name; set the same variable to
that name. Omission creates no new native page; `none` explicitly declines
active native materialization and leaves consumer content untouched. The command
reports `not_selected` separately from creation/failure. Neither choice mounts,
copies or activates templates/assets. Existing exactly owned pages keep their
working body/handler and presentation choice across an upgrade with no new
creation selector. An explicit decline does not delete existing pages; deliberate
changes to their operator-owned integration remain the operator's responsibility.
Explicit source withdrawal still protects an existing owned page.

When positively selected, that command emits the chosen shortcode invocation. An
operator choosing that native publication path must provide its handler through
the optional package mounts or an operator-owned shortcode of the same name.
Omitting both prevents Hugo from building those generated pages; Hugo identifies
the missing `discussionbridge` shortcode template. Choose the optional package
mounts or configure an equivalent owned handler, then rebuild before publishing.
The `prepare`
command itself needs only its JSON manifest and may be used with an independent
site integration.

On the trusted build machine, keep the connection secret in a protected file
outside content, data, static and public output. Supply the README's environment
settings and preserve the operational state across builds and updates. Generate
the manifest, prepare its nonsecret records, then build the final site:

```sh
hugo --renderSegments discussionbridge-manifest
./node_modules/.bin/discussionbridge-hugo prepare \
  --manifest public/discussionbridge-manifest.json \
  --output data/discussionbridge.json \
  --state .discussionbridge/hugo-publication-state.json
hugo
```

Do not publish the intermediate manifest-only build as a completed site. The
shortcode reads the prepared `data/discussionbridge.json` by content basename.
The CLI validates source identities and sanitizes its article/reply HTML; keep
that data generated by the adapter rather than inserting arbitrary HTML.

With a prepared Simple record, the shortcode renders the supplied reply snapshot
and loads `simple.js` for a credential-free public refresh. Without a prepared
snapshot, the inherited integration uses the native Discourse embed; it does
not provide Simple reply cards in that case. Full uses an exact prepared or
frontmatter topic ID, otherwise Discourse's canonical-page embed lookup.
Interactive and From Discourse show a preparation message until a mapped record
exists. Verify the final mapping and rendered discussion before publication.

Allow the site's exact origin through the forum's public CORS setting for
Simple refreshes. Site security policy must permit the forum's native embed and
the packaged scripts. Interactive behavior and sign-in depend on the existing
forum/plugin configuration; a static build does not qualify actual browser,
session or private-source behavior.

## Update and rollback

Select the compatible immutable replacement artifact, preserve protected
configuration/state and site content, update the consumer dependency and mounts,
then regenerate records and the final site. Verify the chosen shortcode and
assets, stable URL/topic identities and current discussion. Preserve
the operator's template, discussion and rich-rendering choices across upgrades;
install/update must not replace site-owned handlers or turn omitted mounts on.
Retain the preceding artifact, consumer lock, content/data/state backup and
final site for rollback.
Never reset state to make an update appear successful.

The build candidate negotiates publication extension `0.3.0-alpha.1`. Complete
From bodies transfer in authenticated chunks and are validated by resource,
edition, offsets and SHA-256 before sanitization. Source title/body/date/author/
forum-name changes continue on the same native identity. Locally changed managed
fields produce record-specific attention; unrelated properties, body text and
explicit presentation choices remain unchanged. Source dates remain distinct
from synchronization time. To pages with authoritative dates carry a complete
body digest and compare-and-swap revision; large bodies use bounded excerpts
with a canonical Read More link.

Explicit withdrawal marks only exactly owned native pages as draft and purges
source bodies from prepared renderable data. It never follows from absent
inventory records, authentication or network failures. Protected recovery state
retains identity and metadata, not full bodies. Restoration rehydrates the
source and uses the same page. Hugo normally leaves old destination files when
a page becomes draft: choose a clean/staging final build (for example,
`hugo --cleanDestinationDir`) and deployment removal of withdrawn output. Local
file changes do not establish public withdrawal; verify the deployed URL before
recording public completion. No separate worker or publication identity is added.

## Template and bundle provenance

The generic shortcode, manifest and credit partial were derived from the
existing local Hugo demo integration. The preserved originals and SHA-256
records are outside the deployable package under
`_trash/cleanup-20261012/hugo/NATIVE-TEMPLATE-PROVENANCE.json`. The package removes
the old mode alias and uses the installed Hugo version in presentation metadata.
It carries no demo-specific theme, navigation or source corpus.

`src/browser-rich-content.mjs` derives the Mermaid wrapper and mathematics
handling from the maintained Ghost renderer. Original bundle/source/lock hashes
are preserved in the lane recovery snapshots. Hugo owns its source and exact
Mermaid 11.17.2, KaTeX 0.18.0 and esbuild 0.25.10 dependency identities.
`npm run build` regenerates both bundles; mathematics styles and fonts are
embedded in the selected rich script, with no consumer CSS/font mount required.
This adds no site/theme activation. The native build test qualifies
package mounts and generated output, not live forum or deployment acceptance.
