---
description: "The DSH plugin that gives archived sessions a true delete — a two-step-confirmed removal of the session's local transcript, projection cache, and subagent sessions, plus the registry and live-session cleanup that makes the row leave the sidebar; for Harness users who archive sessions and for maintainers of this plugin."
kind: "package-reference"
---

# dsh-true-delete

English | [中文](README.zh.md)

## Summary

`dsh-true-delete` adds one destructive action the shipped Harness Web sidebar does not have: **Delete local files…** on an archived session row. Choosing it asks the Host what would actually be removed, shows the exact paths and sizes, and only after explicit confirmation deletes the session's transcript directory (every stored format generation plus crash leftovers) and its projection-cache record, together with any subagent sessions the parent owns. It then drops the id from the workspace registry (archive set, pin set, and workspace membership), releases the live in-memory session the Host would otherwise keep listing, and asks the page to re-pull the session list — so the row leaves the sidebar instead of lingering as a ghost. It is a plugin rather than a fork: the Host half is an ordinary Loader bundle exposing three loopback routes, and the browser half is a hand-written `__ModuleLoader__` bundle with no build step. Content-addressed attachments, the request-image cache, other sessions, and the legacy `session_projcache.json` are never touched.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle into the `desktop` profile, then open the `…` menu of an archived session in the sidebar. The new row appears below Rename, Fork, and Unarchive, and only on archived rows; an ordinary session never offers it. Installing a package the profile has not loaded before takes effect in the running application through HMR; replacing the code of an already-loaded package needs a restart, as noted under [Known Limitations](#known-limitations-and-deferred-work).

### Install

Two things must both happen: the package has to land in the profile's `node_modules`, and its name has to be selected in `dsh.profile.bundles`. The in-app plugin manager (Settings → Plugins) does both; the CLI installs only, so pair it with `scripts/enable-bundle.mjs`.

**By package name** — the ordinary path, available once the package is published:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-true-delete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**From the git repository** — the same shape before a release, and the only name-like install that needs no registry:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:YIYuNCU/DSHTrueDelete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**From a local folder** — development and offline use:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:G:\Code\DSH\DSH-True-Delete
node G:\Code\DSH\DSH-True-Delete\scripts\enable-bundle.mjs desktop
```

**Manually** — the same contract without pnpm: junction `node_modules\dsh-true-delete` at a checkout, add it to `dependencies` and to `dsh.profile.bundles`, and restart. `scripts/enable-bundle.mjs` reads `$DSH_HOME` (default `%USERPROFILE%\.dsh`), removes the pre-rename entry when present, and writes only the bundle list; it ships inside the package, so the `node …` commands above work for a registry install too.

Installing from a git specifier works because the package has no build step and no install scripts: the repository root *is* the published package.

### Publish

`npm publish` runs all three checks first through `prepublishOnly`. The repository also ships `.github/workflows/publish.yml`, which publishes on a `v*` tag (or by manual dispatch) once `NPM_TOKEN` is set as a repository secret.

The package declares its DSH peer range (`^0.2.0-rc.2`) — the manifest field DSH's own compatibility check reads. On an incompatible runtime the profile refuses the plugin with a version diagnostic instead of letting it fail at runtime; `dsh plugin --profile desktop allow-version dsh-true-delete@<version> --dsh-version <runtime> --accept-risk` is the explicit override.

### What you see

The menu row opens a dialog populated by a read-only Host call, so its list of paths is a statement about this computer rather than a description of the feature. Confirming runs the deletion and reports what was removed; the archived row leaves the sidebar as soon as the page re-pulls the list. If nothing on disk belongs to the session any more, the dialog says so and confirming still clears the registry references — deletion is idempotent.

### What it deletes

| Target | Path | Notes |
|---|---|---|
| Session transcript | `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/` | The whole directory: `session[.vN].jsonl.zstd` generations plus `*.tmp` crash leftovers |
| Projection cache | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | Derived title, stats, todos, and plan rows; a bad record's `.bak.*` siblings go too |
| Subagent sessions | The two rows above, for each `childId` in the parent's `subagentCatalog` | Subagent sessions have no sidebar entry of their own, so the parent is their only way back |

Deleting files is only half the work; the other half is what makes the row leave:

1. Remove the files listed above, including nested subagent sessions.
2. Clear the id from `workspaceRegistry` — the archive set, the pin set when pinned, and every workspace's member list.
3. Release the live session object. The Host composes its session list from stored logs **and** live sessions, so an idle in-memory object keeps an already-deleted session listed.
4. Ask the page to re-run `sessions.refresh()` so the list is rebuilt from the Host's current truth.

A short sweep after steps 1–3 re-checks the same paths once, so a disposal flush or a projection-cache write-behind cannot quietly recreate a log directory behind the deletion.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Two halves, one package

`package.json` declares both halves the Harness way: `dsh.bundle.patch` mounts the Host entry from `cordis.patch.yml`, and `dsh.client.platform: 'web'` makes `exports['./client']` a browser module that the module system serves and loads like any shipped plugin. The browser module id must equal the package name, because the loader normalizes `<id>/client` back to the bare id. Card text and artwork come from the manifest without activating the plugin: `locale/en.json` and `locale/zh.json` carry `meta.title` and `meta.description`, and the top-level `icon` names an in-package SVG, both listed under `exports` and `files`.

### Host routes and the trust fence

`lib/index.js` registers three exact routes on `webServer` inside one injected fiber, so they follow its lifetime:

| Route | Purpose |
|---|---|
| `GET /dsh-true-delete/version` | Self-report: which generation of this file, and which capabilities, the running Host process actually loaded |
| `GET /dsh-true-delete/status?sessionId=…` | Read-only plan: targets, sizes, archive state, live state, running work |
| `POST /dsh-true-delete/delete` | The deletion and every cleanup step |

Every route passes the same fence before its handler runs: a well-formed loopback `Host`, no `Sec-Fetch-Site: cross-site`, an `Origin` that matches the authority when present, and — for writes — a loopback origin. When the deployment's own `connection.requestRejection` is available it is delegated to as well. The fence fails closed: a malformed request or a throwing check is a rejection. Every path is additionally constrained by an `underHome()` check against `$DSH_HOME` and by a session-id allow-list, so a crafted id cannot aim the deletion at an unrelated file.

### Locating a session's files

Transcripts live under a project directory named after the session's canonical cwd, which the plugin does not need to know: it scans `<DSH_HOME>/sessions/*/<sessionId>` and matches the id exactly, never fuzzily. Subagent sessions come from the parent's projection-cache record (`record.rows.subagentCatalog.val.head.values[].childId`), read **before** anything is deleted, and the walk recurses to a bounded depth with a visited set. The plan therefore names real paths and real byte counts, which is what the dialog renders.

### Why the row would otherwise survive

`dsh-session-query`'s `listSessions` returns the union of persisted records and `ctx.sessions.list()`; a session archived while open stays in that store, so removing its files changes nothing the sidebar can see. The session store exposes removal only to the owner of `enter()`'s disposer, so the plugin reads the public `liveEntryFor` entry and calls `detachEntered` — the same teardown path a normal session close takes, including its `session/disposed` emission. `workspaceRegistry` exposes `list()`, not a `workspaces` accessor; detaching from a workspace that does not contain the id is an idempotent no-op, so the cleanup walks every workspace.

### Client registration

`lib/client.js` is a plain script that calls `window.__ModuleLoader__.load` with the package id. It registers one row into the `sidebar.workspaces.session.menu.item` list (order 500) and one overlay into `shell.overlay`. The row reads the archive set from the public `workspaces` client service and projects it through a memoized snapshot, because `useSyncExternalStore` requires a stable reference per data version; it returns `null` for unarchived rows. Only platform seed modules are required (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives`), which is why the bundle needs no build step and no bundled dependencies.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the plugin-authoring material the Harness ships, then the packages this plugin consumes. Everything below resolves from an installation; `node tools/asar.mjs cat <innerPath>` reads any of them out of `app.asar` (`DSH_APP_ASAR` overrides the archive path).

- `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development` — bundle manifest, Host export forms, Client manifest, and slot registration, plus the templates this plugin's shape follows.
- `@deepseek-ai/dsh-client-modules/README.md` — how `dsh.client` becomes a served browser bundle, and why the browser module id is the package name.
- `@deepseek-ai/dsh-client-ui-slots/README.md` — registration options, injected props, hooks, and declaration-aware `slots.inject`.
- `@deepseek-ai/dsh-client-ui-workspace/README.md` — the sidebar row, its menu list, and the archive action this plugin mirrors.
- `@deepseek-ai/dsh-workspace/README.md` — the registry whose archive, pin, and membership state the deletion clears, and its statement that session deletion is an absent capability.
- `@deepseek-ai/dsh-session-persistence-jsonl/README.md` — the on-disk layout of a session transcript, which is what this plugin removes.

-----

<a id="model-experience"></a>
## Model Experience

None. The plugin registers no tools, commands, or prompt content, and it never appears in a model request: its Host half serves three loopback routes and its browser half renders a menu row and a dialog.

#### KV Cache effect

None; the plugin neither assembles nor sends a provider request. Deleting a session removes history the model will no longer be asked about — it does not invalidate a cache a running turn still reuses.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Host-half changes need a process restart** — DSH's Host-side HMR watches no module roots, and re-creating the Loader entry re-imports through Node's ESM cache, so the same specifier keeps running the old module. Only a fresh process, or a package name the profile has not loaded, yields new Host code. The browser half hot-reloads on its own.
- **Running work is refused, not forced** — a session still reporting activity through the `workspace/session-activity` waterfall is rejected, with the activity kinds named in the dialog. Archiving stops a session's work, so an archived row is normally inactive.
- **Attachments and caches are deliberately out of scope** — `attachments/**` is content-addressed and deduplicated across sessions, and `cache/**` holds shared request images; neither carries per-session attribution on disk.
- **A dangling id can outlive the deletion** — an id left in a workspace record by an interrupted run is filtered at read time and pruned by the next workspace mutation, so it is invisible rather than harmful.
- **The legacy `session_projcache.json` is never edited** — its records belong to an older layout that the current storage re-seeds from only while no per-record documents exist.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Both halves are verified offline, and a third check keeps this documentation honest; none of the three needs DSH running.

```bat
npm test                          :: docs + host + client, all offline
node tools/check-docs.mjs         :: bilingual anchors, manifest, icon, card metadata
node test\host.test.mjs           :: KEEP=1 keeps the temporary DSH_HOME for inspection
node test\client.test.mjs         :: reads the real primitives build out of app.asar
```

`tools/check-docs.mjs` enforces the package-reference shape this file follows: frontmatter, the canonical sections, one anchor per section, identical anchors across the bilingual pair, the manifest's `files`/`exports`/`icon` entries, and card metadata in both locale files.

The Host suite drives `lib/index.js` inside a fake cordis context over a fake `$DSH_HOME` in the system temp directory: the trust fence, the plan (two levels of subagents, a bad `childId`, a `.bak` sibling, another session, shared attachments), refusal for unarchived and for active sessions, the deletion, registry cleanup, live-session release, the sweep catching a simulated write-behind, an idempotent re-read, and the version route. The Client suite evaluates the browser bundle against a fake `window.__ModuleLoader__`, asserts that every `require` is a platform seed and every `primitives.X` exists in the installed build, then renders both registrations and checks that the request URL keeps its query string.

This package intentionally ships no `README.i18n.yaml`: that record is produced by the monorepo's `pnpm run verify-translation-pairing --write` and is meaningless outside it. The bilingual pair itself is kept, so both files carry the same section skeleton and anchors.

On the styles: class names use the `dsh-true-delete__` prefix and the style tag is keyed by `data-plugin-css`, so a re-registration after a browser reload replaces rather than duplicates styles.

</details>

**Runtime invariant:** the plugin deletes only paths that resolve inside `$DSH_HOME` and match a session-scoped name derived from the requested id; it never removes shared stores, never edits the workspace registry through the file, and reports a degraded step in the response rather than failing the whole deletion.
