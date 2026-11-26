# CVAT Event Hotkeys: development guide

This guide is for developers who continue work on this repository. User documentation is in the [README](../README.md) (Vietnamese).

## Project

- Repository: https://github.com/thunguyen-abc/cvat-hotkey, branch `main`.
- Platform: Chrome extension, Manifest V3, installed with **Load unpacked**.
- Target site: https://cvat-tai.abcstudio.online. Reference job: `/tasks/681/jobs/6306`.
- Release baseline: `v1.7.1` (Quickstart frame position and event ratios). Check GitHub Releases before choosing the next version.

The extension adds features to the existing CVAT annotation UI. It does not need any change to the CVAT server. Continue with this codebase; do not rewrite it.

## Source layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension config and version. The release workflow requires `version` to equal the pushed tag. |
| `cvat-bridge.js` | Runs in the page's **MAIN** world. Registers through `window.cvatUI.registerComponent` and works on the job CVAT holds in memory: reads tags, applies range plans, clears tags, refreshes the view. Makes no network request. |
| `range-plan.js` | Pure planner for range edits (add, replace, remove selected, remove all), and `CVAT_EVENT_LABELS`, the slot 1/2/3 event list shared with `hotkeys.js` and the range panel. |
| `bridge-client.js` | Isolated-world client for the bridge (DOM events carrying JSON), the rate-limited GET queue, and the "saved or not" status text. |
| `hotkeys.js` | Keys `1`/`2`/`3` toggle `event_smoke`/`event_drinking`/`event_phone` on the current frame. Switches Standard jobs to Tag annotation once per job load. |
| `range-editor.js` | Quickstart panel (job frame position, Start/End, event coverage, + / − queue, Apply), the progress-bar highlight and the **Nâng cao** dialog. Panel and dialog share one Apply path. |
| `complete-next.js` | **Complete & Next** and **Clear All Tags** (with the job's live tag count) buttons. |
| `tests/fake-cvat.html`, `tests/simulated_cvat.py` | Simulated CVAT job and the regression test. Not shipped in the ZIP. |
| `complete-next.css` | Styling for every injected control and dialog. |
| `updates.js` | Service worker. Checks GitHub Releases every 6 h and sets the `NEW` badge. Activates new files that the desktop updater wrote to disk (see below). |
| `update.html`, `update.js` | Toolbar popup: installed version, release check, manual ZIP link, desktop-updater status. |
| `updater/cvat-hotkey-updater.ps1` | Windows desktop updater: `setup`, `check`, `status`, `rollback`, `uninstall`. Must be saved as **UTF-8 with BOM**. |
| `updater/Setup-Updater.cmd` | Double-click launcher for the script. |
| `.github/workflows/publish.yml` | On a `v*` tag push: syntax checks, packaging, SHA-256 file, GitHub Release. |
| `docs/auto-update.md` | Updater design, security review, troubleshooting (Vietnamese). |

Content scripts do not call `chrome.*` APIs. This is deliberate: when the extension reloads itself, the scripts already in open CVAT tabs keep working until the page reloads. Keep it that way, or handle invalidated extension contexts first.

## Working with CVAT's in-memory annotations

The Quickstart header reads the player slider for the zero-based job position and inclusive job size. It observes player changes independently of range planning. Event card ratios come from the range snapshot and count distinct frames per event over the inclusive Start–End span. The queued plan supplies the projected numbers shown beside the ratios.

The deployed server runs CVAT **2.56.1** (`/api/server/about`). When a job opens, CVAT loads all of its annotations into a client-side collection (cvat-core). It saves by comparing that collection with the copy it last received from the server, and sends only the difference: one `PATCH …/annotations?action=update`, one `action=delete` and one `action=create`, each only if non-empty. Each is retried on 504. Autosave runs on the user's `autoSaveInterval`. "Finish the job" saves first, then sets the state to completed.

The extension therefore never writes annotations itself. It changes the collection the way CVAT's tag sidebar does, and leaves the upload to CVAT's save:

- **Plugin entry:** `window.cvatUI.registerComponent(builder)`. The builder receives `{ core, store, dispatch, actionCreators }`. `cvat-bridge.js` keeps that object. Chrome injects a file only once per page even when two `content_scripts` entries list it, so the MAIN-world entry contains `cvat-bridge.js` only.
- **Read:** `store.getState().annotation.job.instance` is the job. The range editor reads **only the frames between Start and End**, one at a time, with `job.annotations.get(frame, false, [])` (tags filtered by `objectType`), and checks `job.frames.search({ notDeleted: true }, frame, frame)` for deleted frames and frame filters. Both come from memory and cached frame meta. Labels come from `job.labels`. Only Clear All Tags, which is job-wide, uses `job.annotations.export()`. The count on that button comes from `job.annotations.statistics().total.tag` (export as fallback): the bridge subscribes to the store and announces it (`cvat-event-hotkeys:tags-changed`) 250 ms after `annotation.annotations.history` or the job changes, which also makes the range panel re-read its range.
- **Write:** create tags with `job.annotations.put([new core.classes.ObjectState({ objectType: core.enums.ObjectType.TAG, label, frame })])`. Delete them with `state.delete(frame, true)` on the states from `job.annotations.get(frame, false, [])`. Each delete is one Undo step.
- **Refresh:** dispatch `FETCH_ANNOTATIONS_SUCCESS` with `{ states, history, minZ, maxZ }` built from `job.annotations.get(currentFrame, showAllInterpolationTracks, filters)`, plus ground-truth states when shown. This is CVAT's own `fetchAnnotationsAsync`, the path the tag sidebar uses after creating a tag. **Never call `changeFrameAsync` on the current frame:** `CHANGE_FRAME` sets `canvas.ready = false`, and on the same frame the canvas only emits `OBJECTS_UPDATED`, not `canvas.setup`, so `CONFIRM_CANVAS_READY` never comes and CVAT shows loading until the page reloads. v1.6.0 had this bug; `tests/simulated_cvat.py` now checks `canvas.ready`.
- **Cache:** the bridge keeps a per-frame cache (`frame -> { tags, valid }`) for the open job. Reopening Edit on an overlapping range reads only the frames not cached yet; changing frame or saving keeps the cache. The key is CVAT's undo history from the store, which changes with every annotation action, so any tag change, undo or redo empties it. Apply always re-reads its range live and compares fingerprints, because the history is capped at 32 entries without ids, so a stale hit is possible but never applied. After Apply, untouched frames of the range stay cached and only the changed frames are re-read. Clear All keeps the cached frames (now without tags), like Apply; Complete & Next drops the cache and removes the job's Start/End marks.
- **Safety:** the bridge refuses to work while `annotation.annotations.saving.uploading` is true. `rangeSnapshot` returns a fingerprint of the tags in the range. `applyRange` re-reads the live tags, refuses a changed fingerprint (`stale`), checks every planned delete and create (no tag outside the range, no duplicate target), and only then applies. `clearSnapshot`/`clearAll` do the same over the whole job.
- **Keys:** the range panel listens on `window` keydown in the capture phase, once per mount (an `AbortSignal` removes it on remount or job change), and calls `preventDefault` + `stopImmediatePropagation` only for keys it uses, so CVAT's Mousetrap (document, bubble) never sees them; auto-repeat of a taken key is swallowed too. It stays out of Standard, text fields, dialogs and open Ant Design overlays. `Alt+1/2/3` was chosen because Chrome on Windows keeps `Ctrl+1…8`; confirm on a real job after CVAT keymap changes.

These are internal CVAT structures, not a published API. They match 2.56.1. After a CVAT upgrade, run `tests/simulated_cvat.py` and test once on a real job. If they change, update the bridge.

### Server requests per feature

| Feature | Requests made by the extension |
| --- | --- |
| Hotkeys, Start/End, panel keys | none |
| Quickstart panel and Nâng cao (read, preview, apply) | none |
| Clear All Tags (count, clear) | none |
| Saving | none: CVAT's save sends only changed tags, at most 3 requests |
| Complete & Next | 1 GET to confirm Completed, plus 1–2 GETs `/api/jobs?filter=…&page_size=1`. `users/self` and the job are read from the store; 2 GETs are used only if the bridge is unavailable. If the server rejects the JSON filter (HTTP 400), the old scan of 100 jobs per page is used, capped at 20 pages. |

All direct GETs go through `cvatEventRequests` in `bridge-client.js`: one request in flight, ≥ 250 ms apart, 2 retries on 429/502/503/504 with backoff and `Retry-After` (≤ 30 s). v1.5.1 and earlier issued several full `GET …/annotations` per Edit or Clear and reloaded the whole page afterwards. Those calls are gone.

## Update mechanism

1. A tag push publishes `cvat-event-hotkeys-vX.Y.Z.zip` and `cvat-event-hotkeys-vX.Y.Z.zip.sha256`.
2. On each user's machine, the scheduled task runs `cvat-hotkey-updater.ps1 check -Scheduled` at logon and every 3 h. It verifies the ZIP (SHA-256 against the GitHub API `digest` and the `.sha256` asset, path allowlist, manifest name and version, permission diff). In `confirm` mode it asks first. Then it backs up the current install and writes the new files, with `manifest.json` last.
3. The popup's **Cập nhật ngay** button sends `{ type: 'update' }` through the service worker to the native messaging host `com.abcstudio.cvat_event_hotkeys`, which `setup` registers for Chrome and Edge, and every `check` refreshes. The host checks the caller origin, starts a detached `check -Scheduled -Confirmed -Force` and replies at once. The popup then follows `updater-state.json`. `allowed_origins` holds the unpacked extension ID computed from the true-case folder path (SHA-256 of the UTF-16LE path, upper-case drive letter, first 16 bytes, nibbles mapped to `a`–`p`). Without a registered host, the popup falls back to the manual ZIP link.
4. `updates.js` fetches its own `manifest.json` from disk every minute, on browser startup and when the popup opens. When the version differs from the running one, it calls `chrome.runtime.reload()`.

Points that are easy to break:

- **Permission changes.** The updater asks the user whenever a release adds permissions, host permissions, content-script matches, `externally_connectable` or `web_accessible_resources` entries, even in `auto` mode. Explain every new permission in the release notes.
- **New file types or folders.** The updater accepts only these extensions: `.js .css .html .json .md .txt .png .svg .ps1 .cmd`. Folders can be at most one level deep, and names cannot start with `.` or `_`. Users run their installed copy of the updater when the next release arrives. If a release breaks these rules, every installed updater rejects it, so widen the allowlist in one release before you depend on it in a later one.
- **Packaging list.** `publish.yml` zips an explicit file list plus the `updater` folder. Add new files there.
- **Encoding.** Windows PowerShell 5.1 reads a script without a BOM as ANSI. The workflow fails if the BOM is missing.

Verified on 2026-11-25 on Windows 10 with PowerShell 5.1 and Chromium 1248:

- Install, no-op re-check, rollback, skip after rollback, and confirm mode (decline and accept) against the real v1.5.1 release.
- Hostile ZIPs are rejected: `..`, absolute paths, nested folders, `.exe`, `con.js`, hidden and `_` names, duplicates, wrong name, wrong version, missing manifest.
- A release that adds permissions is flagged.
- Non-HTTPS and non-GitHub URLs are refused, and so is a git working copy as the extension folder.
- The scheduled task registers as a standard (non-admin) user.
- An extension loaded as unpacked switches to the new version after a disk change: at once when the popup opens, and within 80 s from the alarm alone. Chrome keeps it enabled only while Developer mode is on.

## Range editor: several operations

Since v1.6.3 the dialog holds a list of operation cards (UI ported from the unpublished 1.6.0 draft). `range-plan.js` `planCVATRangeBatch` projects the operations top to bottom on the snapshot of the range. Each card sees the tags left by the cards above it. A card without a target, without a selected source, with a source that no longer exists, or with source = target gets a `problem` and blocks Apply. The final state is diffed against the original: unchanged `(frame, label)` pairs are kept, relabels count as "Đổi", and the result is `{ create: [{ frame, labelId }], delete: [{ clientID, frame }] }`. The bridge re-reads the range, refuses a changed fingerprint, checks that every delete exists and that no `(frame, label)` pair would be duplicated, then deletes and creates (one `put`). Unit tests: `node tests/range_plan_test.js`, also run by the release workflow.

## Complete & Next

Save → Completed → next job, each step confirmed. CVAT 2.56's "Finish the job" (`finishCurrentJobAsync`) saves, then calls `updateJobAsync(job, { state: 'completed' })`, and shows the `cvat-annotation-job-finished-success` message **only when the job was already completed**. Earlier versions waited for that message, so they timed out and never moved on. v1.6.3 does the steps itself:

1. Bridge `saveStatus`. If unsaved, click CVAT's Save and wait until `saving` is false and nothing is unsaved; a new "Could not save" notice aborts.
2. Bridge `completeJob` dispatches `actionCreators.updateJobAsync`, then one GET confirms `completed` on the server.
3. Clear the job's cache and Start/End, then find the next job with the server filter. If the filter errors or finds nothing, scan the task's job list (100 per page, at most 20 pages).

Without the bridge, the menu's Finish is used and completion is detected by polling the job state (at most every 2 s, through the rate-limited queue).

## Range editor: status and remaining work

Done after v1.5.1, in the change that added the bridge:

- Edit and Clear All Tags work on CVAT's in-memory annotations. No page reload, no extension request; the current job and frame stay as they are.
- The new tags show at once. CVAT's own save uploads them (diff only), so a later native Save cannot overwrite them with stale state: they *are* CVAT's state.
- Start/End and the highlight stay after Apply (user request, replacing the handover's reset), so Edit can be reopened on the same range at once; they are stored per job in sessionStorage and cleared by Complete & Next. On failure the dialog keeps its selection for a retry.
- The dialog blocks double submission, marks destructive operations, previews add/replace/remove counts, and refuses to apply if the tags in the range changed after the preview.

Still open, from the original handover:

1. ~~**Several operations in one dialog.**~~ Done in v1.6.3 (see below). Original text: the dialog applied one operation (add, replace, remove selected or remove all) per Apply. Several Applies before one save already cost no extra requests, but the handover asks for an operation list in one dialog. Compute the final tag set for each frame from the whole list, in the order the user added the operations, show that order in the preview, and never resolve an ambiguous conflict silently. `range-plan.js` is the place for it. The bridge already accepts any concrete plan of creates and deletes and validates it.
2. **Live verification** on an authorized test job (see the checklist).

The local `outputs/cvat-event-hotkeys/` and `work/` folders from the previous session were never committed. Their batch-operation draft is superseded by the bridge design.

Rules that must stay:

- The range includes both Start and End.
- No duplicate tags.
- Frames outside the range do not change.
- Boxes, polygons and tracks do not change.

### Acceptance checklist

Checked by `tests/simulated_cvat.py` (simulated CVAT, 2026-11-25):

- [x] Start/End define an inclusive range; deleted frames are skipped when adding.
- [x] No duplicate tags; frames outside the range and non-tag annotations do not change.
- [x] No page reload, no extension request during Edit or Clear All; the view refreshes.
- [x] CVAT's save afterwards sends only the changed tags (one delete and one create request).
- [x] Start/End kept after Apply and Save, cleared after Complete & Next; a change between preview and Apply is caught.
- [x] Editing several ranges one after another works.
- [x] Complete & Next: save -> completed -> next in order, nothing-to-save skips the save, filter miss falls back to the page scan, user from state, 503 retried after `Retry-After`, next job found with one filtered `page_size=1` request.

Still to check on a real job:

- [ ] Keyboard shortcuts still work.
- [ ] Several operations in one dialog (built in v1.6.3, covered by simulation; check on a real job).
- [ ] Tags show at once in the real tag sidebar, and autosave/Save uploads them.
- [ ] Annotations are still correct after the job is reopened manually.
- [ ] The update check and the desktop updater still work.

## Testing

- Syntax: `node --check` on every `.js` file. PowerShell: `[System.Management.Automation.Language.Parser]::ParseFile(...)`.
- Regression: `python tests/simulated_cvat.py`. It loads the extension unpacked into Playwright's Chromium, serves `tests/fake-cvat.html` at the CVAT URL, fakes the API, and counts every request. Also check dialogs at 390 px and 1366 px widths.
- Live: use an authorized test job only, never production annotations.
- Native button, end to end: `python tests/native_update.py`. It installs a fake older copy, runs `setup` in test mode (host registered for Chromium only, under `HKCU\Software\Chromium\NativeMessagingHosts`), clicks **Cập nhật ngay** in Chromium, and expects the latest GitHub release on disk and running. It cleans up the registry key, task and folders afterwards.
- Updater: set `CVAT_HOTKEYS_UPDATER_HOME` to a temporary folder. This isolates config, logs, backups and the task name (`… (test)`). Dot-source the script to call `Test-ReleaseArchive`, `Get-PermissionSet` and the other functions directly. To test Chrome activation, load the extension through CDP `Extensions.loadUnpacked` with Developer mode on. Extensions loaded with `--load-extension` are disabled by `chrome.runtime.reload()`, so they cannot test this path.

## Release

1. Run the syntax and regression checks.
2. Bump `version` in `manifest.json`. Update the README if behaviour changed.
3. Commit, push `main`, then push the tag `vX.Y.Z`.
4. Watch the workflow with `gh run watch`. Then check the release with `gh release view vX.Y.Z`: both the `.zip` and the `.zip.sha256` must be present.
5. Download the ZIP and confirm its contents. On a test machine, run `Setup-Updater.cmd check`.

Use only this release process. Do not create another repository or distribution channel.
