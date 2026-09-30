---
description: "A DSH plugin that really deletes an archived session: the sidebar's … menu gains a Delete local files… action that lists exactly what will be removed, asks once, and then deletes the transcript, projection cache, and subagent sessions — clearing the registry and live-session state so the row leaves the sidebar too."
---

# dsh-true-delete

English | [中文](README.zh.md)

DSH can archive a session, rename it, and restore it — but nothing ever removes it. Archived sessions keep their files on disk indefinitely. This plugin adds the missing action and finishes the whole job, so a deleted session does not come back as a ghost row.

## Table of Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Use it](#use-it)
- [What gets deleted](#what-gets-deleted)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [For maintainers](#for-maintainers)
- [License](#license)

-----

<a id="what-it-does"></a>
## What it does

The `…` menu of an **archived** session gains one row: **Delete local files…**, below Rename, Fork, and Unarchive. It opens a dialog listing exactly what would be removed from this computer — real paths, real sizes — and deletes nothing until you confirm:

- the session's transcript directory, covering every stored `session[.vN].jsonl.zstd` generation and any crash leftovers;
- its projection-cache record (the derived title, statistics, todos, and plan) including `.bak` siblings from a damaged record;
- every subagent session the parent owns — those never appear in the sidebar, so the parent is their only way back.

Removing files is only half of it. DSH builds the session list from stored logs **and** from live in-memory sessions, so deleting files alone leaves a row you cannot open and cannot get rid of. The plugin also clears the id from the workspace registry (archive set, pin set, and workspace membership), releases the live session object, and asks the page to re-pull the list — the row disappears.

<a id="install"></a>
## Install

Two things must both happen: the package has to land in the profile's `node_modules`, and its name has to be selected in `dsh.profile.bundles`. **Settings → Plugins** does both; the command line does only the first, so it needs the second command as well. After installing, restart DSH once — a plugin's Host half is loaded at startup.

**By package name** — the ordinary path, available once the package is on the registry:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-true-delete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**From the git repository** — works before a release, and needs no registry:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:YIYuNCU/DSHTrueDelete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**From a folder on this machine** — for a checkout or an offline install:

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:G:\Code\DSH\DSH-True-Delete
node G:\Code\DSH\DSH-True-Delete\scripts\enable-bundle.mjs desktop
```

The helper reads `$DSH_HOME` (default `%USERPROFILE%\.dsh`), clears the pre-rename entry if one is left over, and writes only the bundle list.

<a id="use-it"></a>
## Use it

1. Archive the session — or pick one that is already archived. The action only appears on archived rows; an ordinary session never offers to delete anything.
2. Open its `…` menu and choose **Delete local files…**.
3. Read the dialog. It lists every path with its size and says how many subagent sessions are included. Nothing has been touched yet.
4. Press **Delete permanently**. The files go, the registry is cleaned, and a toast reports how many files and how much data were removed.
5. The row leaves the sidebar as the page re-pulls the list.

Cancel at any point and nothing happens — the dialog is read-only until you confirm.

<a id="what-gets-deleted"></a>
## What gets deleted

| Target | Path | Notes |
|---|---|---|
| Session transcript | `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/` | The whole directory: every `session[.vN].jsonl.zstd` generation plus `*.tmp` crash leftovers |
| Projection cache | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | Derived title, statistics, todos, and plan; a damaged record's `.bak.*` siblings go too |
| Subagent sessions | Both rows above, for each `childId` in the parent's `subagentCatalog` | Subagent sessions have no sidebar entry of their own |

`<DSH_HOME>` is `%USERPROFILE%\.dsh` unless the `DSH_HOME` environment variable says otherwise.

After the files are gone the plugin finishes four cleanup steps: it clears the id from the workspace registry, releases the live session object, drops the projection-cache record, and waits a quarter second to re-check the same paths once — so a shutdown flush or a cache write-behind cannot quietly recreate a log directory behind the deletion.

<a id="safety"></a>
## Safety

- **Archived sessions only.** An unarchived id is refused, and so is a session that is still running work: the dialog names the activity it saw and asks you to stop it first. Archiving already stops a session's work, so an archived row is normally inactive.
- **Nothing shared is ever touched.** Attachments are content-addressed and deduplicated across sessions, the request-image cache is shared, and other sessions are none of this plugin's business — including the legacy `session_projcache.json`, which belongs to an older layout.
- **Deletes are scoped and exact.** Every path is resolved and verified to sit inside `$DSH_HOME`, ids are matched exactly rather than fuzzily, and the plugin refuses a malformed id outright.
- **Only your own machine can call it.** The Host routes refuse cross-site requests, require a matching origin, and accept writes only from a loopback origin; they delegate to DSH's own browser-authentication fence as well.
- **Repeating it is harmless.** Deleting an already-deleted session reports “no local files belong to this session” and still clears any leftover registry references.

<a id="troubleshooting"></a>
## Troubleshooting

**“declares no dsh.bundle” while installing by name.** The registry currently resolves the name to a placeholder instead of the real package — this happens while a first publish waits in npm's staged area, where the name points at a 364-byte stub with no `dsh` field. Install from the git repository or a local folder instead, or release the staged version with `npx npm@11 stage list` and `npx npm@11 stage approve <id>`. Note that a failed install by name also removes whatever installation was already there, so reinstall afterwards.

**The menu row is missing.** Check that `dsh-true-delete` is listed in `dsh.profile.bundles` (run the `enable-bundle.mjs` command again), then restart DSH. The row only appears on archived rows.

**The row is still there after deleting.** You are running a version older than 0.2.0, which cleaned files but not the live session object. Restart DSH and the row disappears, or delete once more.

**“still has running work”.** Something is genuinely running for that session — a turn, a subagent, a job, or a schedule. Wait for it to finish, or use DSH's own stop button, then delete.

**“incompatible with dsh …”.** The package declares which DSH versions it supports. On a different runtime the profile refuses to load it rather than letting it fail at runtime; to accept the risk explicitly, run `dsh plugin --profile desktop allow-version dsh-true-delete@<version> --dsh-version <runtime> --accept-risk`.

**Changed the plugin and nothing changed.** Editing the browser half is picked up on reload; editing the Host half (`lib/index.js`) needs a DSH restart, because Host-side code is not hot-reloaded.

<a id="uninstall"></a>
## Uninstall

Remove `dsh-true-delete` from `dependencies` and from `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json`, delete its folder (or symlink) under that profile's `node_modules`, and restart DSH. Deleting sessions leaves nothing else behind: no settings, no background process, no database.

-----

<a id="for-maintainers"></a>
## For maintainers

<details>
<summary>Implementation, tests, and publishing — click to expand</summary>

### Layout

```
lib/index.js     Host half: three loopback routes, file planning and deletion, cleanup
lib/client.js    Browser half: the menu row and the confirmation dialog (hand-written bundle)
cordis.patch.yml Bundle mount declaration (mounts the Host entry)
scripts/         enable-bundle.mjs (select the bundle in a profile)
locale/          Card title and description for the plugin manager
test/            Offline suites for both halves
tools/           asar reader for inspecting a DSH installation, doc/manifest checker
```

`package.json` declares both halves the Harness way: `dsh.bundle.patch` mounts the Host entry, `dsh.client.platform: 'web'` makes `exports['./client']` a browser module the module system serves and loads like any shipped plugin, `locale/*.json` plus `icon` supply the plugin-manager card, and `peerDependencies['@deepseek-ai/dsh']` is the range DSH's compatibility check reads. The browser module id must equal the package name, because the loader normalizes `<id>/client` back to the bare id.

### Host routes and the trust fence

| Route | Purpose |
|---|---|
| `GET /dsh-true-delete/version` | Self-report: which generation of the Host file, and which capabilities, the running process loaded |
| `GET /dsh-true-delete/status?sessionId=…` | Read-only plan: targets, sizes, archive state, activity |
| `POST /dsh-true-delete/delete` | The deletion and every cleanup step |

Each route passes one fence before its handler: a well-formed loopback `Host`, no `Sec-Fetch-Site: cross-site`, an `Origin` matching the authority when present, and loopback-only writes — plus delegation to the deployment's own `connection.requestRejection`. It fails closed. Paths additionally pass `underHome()` and a session-id allow-list.

### Why the row would otherwise survive

`dsh-session-query`'s `listSessions` returns persisted records **unioned** with `ctx.sessions.list()`, and a session archived while open stays in that store. Removal is exposed only to the owner of `enter()`'s disposer, so the plugin reads the public `liveEntryFor` entry and calls `detachEntered` — the same teardown a normal close takes, including its `session/disposed` emission. The registry exposes `list()`, not a `workspaces` accessor; detaching from a workspace that does not contain the id is an idempotent no-op, so the cleanup walks every workspace.

### Tests

Both halves are verified offline; neither suite needs DSH running.

```bat
npm test                          :: docs + host + client, all offline
node tools/check-docs.mjs         :: bilingual anchors, Chinese headings, manifest, icon, card metadata
node test\host.test.mjs           :: KEEP=1 keeps the temporary DSH_HOME for inspection
node test\client.test.mjs         :: reads the real primitives build out of app.asar
```

The Host suite drives `lib/index.js` in a fake cordis context over a fake `$DSH_HOME`: the fence, the plan (two levels of subagents, a bad `childId`, a `.bak` sibling, another session, shared attachments), refusal for unarchived and active sessions, the deletion, registry cleanup, live-session release, the sweep catching a simulated write-behind, an idempotent re-read, and the version route. The Client suite evaluates the browser bundle against a fake `window.__ModuleLoader__`, asserts every `require` is a platform seed and every `primitives.X` exists in the installed build, then renders both registrations and checks the request URL keeps its query string.

### Publishing

`npm publish` runs the three suites through `prepublishOnly`. Releases go through `.github/workflows/publish.yml` on a `v*` tag or by manual dispatch, with either credential:

- **Trusted Publishing (recommended)** — configure the package's Trusted Publisher on npmjs.com for this repository and `publish.yml`; no secret is needed and npm exchanges the workflow's OIDC token for short-lived credentials. npm is restricting tokens that bypass 2FA for direct publishing, so this is the path that keeps working.
- **`NPM_TOKEN`** — a repository secret. A token that bypasses 2FA may only *stage* the publish; while it waits, the name resolves to the `0.0.0-stage` stub described under Troubleshooting, and installing by name fails until the stage is approved or rejected.

### Documentation conventions

`README.md` is English and `README.zh.md` is Chinese, with **Chinese headings** in the Chinese file; both share one set of `<a id>` anchors so the two versions stay parallel. `tools/check-docs.mjs` enforces that, together with the manifest's `files`/`exports`/`icon` entries and the card metadata in `locale/`. The pair intentionally ships no `README.i18n.yaml`: that record is generated by the monorepo's `pnpm run verify-translation-pairing --write` and is meaningless outside it.

**Runtime invariant:** the plugin deletes only paths that resolve inside `$DSH_HOME` and match a session-scoped name derived from the requested id; it never removes shared stores, never edits the workspace registry through the file, and reports a degraded step in the response rather than failing the whole deletion.

</details>

<a id="license"></a>
## License

MIT — see [LICENSE](LICENSE).
