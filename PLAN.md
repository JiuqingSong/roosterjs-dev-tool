# RoosterJS DevTools — Feature Roadmap

This tracks planned additions to the DevTools extension (`extension/`), the primary tool described
in [README.md](./README.md). The console script (`roosterjs-devtools-agent.js`) is a lighter-weight
fallback and does not need to track every feature here.

**Constraint: no dependency on RoosterJS source or build tooling** (see README's
[Design notes](./README.md#design-notes) section) — no `import`/`require` of anything outside this
repo, own dependencies declared in `package.json` rather than assumed to be available some other
way, and any new external dependency on "the page under inspection" must go through the public
`RoosterJsDevToolsHook` contract or `IEditor`, never a source import. This is what let this project
move out of the roosterjs monorepo's `devtools/` folder (where it started) into its own repo without
code changes — keep it in mind when picking an approach for anything below.

## Why these features

The roosterjs demo app's [side pane](https://github.com/microsoft/roosterjs/tree/master/demo/scripts/controlsV2/sidePane)
has a much richer set of debugging panes than the extension currently does, because it's compiled
into the demo and has access to internal packages. The extension only has what a page exposes
through the public `IEditor` surface
(`packages/roosterjs-content-model-types/lib/editor/IEditor.ts` in the roosterjs repo) plus whatever
the `RoosterJsDevToolsHook` contract forwards (currently `onEditorCreated` / `onEditorDisposed` /
`onPluginEvent`, see [RoosterJsDevToolsHook.ts](https://github.com/microsoft/roosterjs/blob/master/packages/roosterjs-content-model-types/lib/editor/RoosterJsDevToolsHook.ts)).
So the backlog below is scoped to what's reachable from a MAIN-world content script talking to a
live `IEditor` reference on someone else's page — not everything the demo pane can do.

## Backlog

| # | Feature | Value | Effort | Feasibility | Status |
|---|---------|-------|--------|-------------|--------|
| 1 | **Event Viewer** — live log of `PluginEvent`s | High | Low | Already flows through the hook; just needs buffering + UI | ✅ Done |
| 2 | **Selection Inspector** — current `DOMSelection` (range/image/table) | High | Low | `editor.getDOMSelection()` is public; `selectionChanged` events carry it directly | ✅ Done |
| 3 | **Format State** — editor state (dark mode toggle, environment flags, experimental features, focus/shadow-edit) + format at cursor (bold/italic/font/color/etc.), merged into one tab | Medium | Medium | Editor state: all public `IEditor` getters. Format at cursor: not on `IEditor` — derived client-side (see below) | ✅ Done |
| 4 | HTML source view (read-only, live) | Medium | Low | `DOMHelper.getClonedRoot()` is public | ✅ Done |
| 5 | Raw JSON export of the Content Model | Low | Low | Cheap add-on to the existing tree tab's `serialize()` output | ✅ Done |
| 6 | Undo/redo control strip (`canMove` / `move` / `hasNewContent`) | Low | Low | `SnapshotsManager` doesn't expose the history array, so this is step buttons only, not a full list like the demo's `SnapshotPane` | ✅ Done |
| 7 | Command console (`focus()`, `takeSnapshot()`, `triggerEvent()`) | Low | Medium | Scoped down to `focus()`/`takeSnapshot()` buttons only — see below | ✅ Done (partial, by design) |
| 8 | **Snapshots tab** — full undo/redo stack list, click-to-apply, paste HTML as new content | High | Medium | Originally thought infeasible (`SnapshotsManager` has no list getter) — reconsidered, see below | ✅ Done |
| 9 | Copy/paste a snapshot with selection metadata (`html + <!--{selection,isDarkMode,logicalRootPath}-->`, matching the demo's `SnapshotPane`) | Medium | Low | `Snapshot.selection`/`logicalRootPath` were already being forwarded (item 8); this is string formatting/parsing plus widening `applyHtml`'s signature | ✅ Done |

Items 1–9 are done, with item 7 deliberately scoped down (see below) rather than fully built as
originally described. Item 8 reverses an earlier "non-goal" call — see Feature 8 below for why.

## Architecture for new tabs

The panel gains a tab bar (`Model | Events | Selection`, more later) instead of a single tree view.
Message protocol follows the existing convention in `injected-agent.js` (full-state push, not
diffs) and the existing panel <-> background <-> content-script <-> agent relay is unchanged —
every new tab is just new message types over the same pipe.

### Feature 1 — Event Viewer

- **Agent**: each editor registry entry (`editors[]` in `injected-agent.js`) gets its own ring
  buffer (`events: []`, capped at 100, oldest dropped first) so a panel opened after the page has
  been running for a while still gets recent history.
- Every `onPluginEvent` call appends a JSON-safe summary (`summarizeEvent`) to the current editor's
  buffer — event type, timestamp, and a type-specific detail object (mirrors the
  `switch (event.eventType)` in the demo's `EventViewPane.renderEvent`, but producing data instead
  of JSX). Raw DOM/File references (`rawEvent`, `clipboardData.image`, entity wrappers) are never
  sent across the postMessage boundary, only derived strings/booleans/numbers.
- The agent re-sends the whole buffer for the current editor every time a new event lands
  (`{ type: 'events', editorId, entries }`) — no separate debounce, since entries are tiny and this
  mirrors how `sendModel()` already behaves on every relevant event.
- **Panel**: renders the buffer newest-first as collapsible entries (time + type, expandable
  detail), a display-count selector (20/50/100, client-side slice of the buffer — mirrors the
  demo), and a "Clear all" button that sends `{ type: 'clearEvents' }` to reset the agent's buffer
  for the current editor.

### Feature 2 — Selection Inspector

- **Agent**: `serializeSelection(sel)` converts a `DOMSelection` into a JSON-safe summary per type:
  - `range`: reverted flag, collapsed flag, selected text (truncated), and a `describePoint()` for
    start/end (node kind, offset, text preview — no live node references).
  - `image`: tag name + truncated `src`.
  - `table`: `firstRow`/`firstColumn`/`lastRow`/`lastColumn`.
  - On a `selectionChanged` plugin event, the agent uses `event.newSelection` directly (already has
    it, no need to re-query). On init/editor-switch/refresh it calls `editor.getDOMSelection()`.
- **Panel**: renders a small key/value table (same visual language as the format rows in the Model
  tab), or "No selection" when null.

### Feature 3 — Format State

`getFormatState()` lives in `roosterjs-content-model-api`, a layer above
`roosterjs-content-model-core` (where the hook glue lives), so it can't be imported from a content
script. Two ways to get its output were weighed:

- **(chosen) Reimplement client-side.** Every input `getFormatState()` needs
  (`getPendingFormat()`, `getSnapshotsManager()`, `isDarkMode()`, `getColorManager()`,
  `getDOMHelper()`, `formatContentModel()`) is already public on `IEditor`. The only unreachable
  piece is the merge algorithm itself (`retrieveModelFormatState` + `iterateSelections`, both in
  `roosterjs-content-model-dom`). The agent ports a simplified version of that algorithm
  (`computeFormatState`/`retrieveFormatAtSelection` in `injected-agent.js`), reusing the same
  `editor.formatContentModel()` read-only pass the Model tab already does. Zero library changes;
  stays fully inside this repo per the constraint above. Known gaps vs. the real
  function (acceptable for a debug panel, not for driving actual ribbon UI):
  - No `DOMHelper` container-format fallback for segments that don't specify their own
    font/size/color (`hasAllRequiredFormat` branch in the real function).
  - No exact dark-mode color reverse-mapping via `DarkColorHandler` — colors shown are the raw
    Content Model values, same convention the Model tab's format editor already uses.
  - No detailed table/image metadata (`tableFormat`, `imageFormat`, `imageEditingMetadata`,
    `canMergeTableCell`) — those are editing-ribbon concerns, not "what's the format here" ones.
- **(rejected for now) Extend the library.** `roosterjs-content-model-core` already depends on
  `roosterjs-content-model-dom`, so `devtoolsHook.ts` could import the real
  `retrieveModelFormatState` and forward a byte-identical result through a new optional hook
  callback. Full fidelity, but a real library change (hook contract version bump, new core code +
  tests) rather than a devtools-only addition — revisit if the client-side port's gaps turn out to
  matter in practice.
- **Agent**: `computeFormatState(editor)` builds `{ isDarkMode, canUndo, canRedo, hasFocus,
  isInShadowEdit, ...EditorEnvironment flags, experimentalFeatures }` from direct `IEditor` calls
  (exact, no derivation needed), then does one `editor.formatContentModel()` read-only pass to
  merge in cursor-format fields for whatever's currently selected, using the same "first selected
  segment wins, later conflicts delete the key" rule as the real function. Recomputed on the same
  cadence as the Selection tab (init/editor-switch/refresh/`selectionChanged`), plus after any
  `scheduleRefresh()`-triggering event so toolbar-driven format changes (not just selection moves)
  show up. `setDarkModeState()` is exposed as a real write: a `{ type: 'setDarkMode' }` command
  calls it on the live editor and pushes a fresh format state back.
- **Panel**: one tab, two key/value sections — "Editor State" and "Format at Cursor" — using the
  same table styling as the Selection tab (shared `.kv-view` CSS/`appendKvRows()` helper). A
  checkbox at the top toggles dark mode live.

### Feature 4 — HTML source view

`DOMHelper.getClonedRoot()` is public and does the hard part for us: it deep-clones the editor's
content div into a *detached* document (`ownerDocument.implementation.createHTMLDocument()` +
`importNode`), so reading `.innerHTML` off the clone is a genuinely safe read-only op — it never
touches the live editor DOM. `sendHtml()` pushes that string on the same cadence as `sendModel()`
(init/editor-switch/refresh/`scheduleRefresh()`). Panel renders it into a `<pre class="code-view">`
in a new HTML tab — plain text, no interactivity, so there was nothing to design here beyond wiring
the existing push cadence to one more tab.

### Feature 5 — Raw JSON export

Rather than a new tab, this is a toggle (`{ }` button) on the *existing* Model tab, since it's an
alternate view of the same data, not a separate concern. Two things distinguish it from the tree
view's serialized nodes (`buildTree()`'s `describe()` renames fields for display - e.g.
`blockGroupType` becomes part of a `title` string): `toJsonSafe()` deep-clones the real Content
Model as returned by `formatContentModel()`, keeping actual field names, and replaces the only
thing that can't survive `JSON.stringify` - DOM element references (`cachedElement`, `element`,
`wrapper`, `table`, `image`, ...) - with a short `[DOM <tagName>]` placeholder instead of silently
producing `{}` for them. Fetched fresh on toggle-on and on Refresh (while open), not continuously
live, matching "export a snapshot" rather than "watch it change" - the tree view already covers the
live case.

### Feature 6 — Undo/redo control strip

`moveSnapshot(step)` in the agent replicates the exact sequence the library's own `undo`/`redo`
commands use (`packages/roosterjs-content-model-core/lib/command/undo/undo.ts` and
`command/redo/redo.ts`): `editor.focus()` → if undoing and `hasNewContent`, `editor.takeSnapshot()`
first (so the current state isn't lost) → `manager.move(step)` → if a snapshot came back,
`editor.restoreSnapshot(snapshot)`. Every step is a public `IEditor`/`SnapshotsManager` call, so
this carries none of the reimplementation risk the Format State tab's derived fields do - it's
exercising the real snapshot stack, not a devtools-only shortcut. Originally landed as step buttons
in the Format State tab; moved into the Snapshots tab (Feature 8) once that existed, since they're
snapshot actions and that tab shows the list they act on.

### Feature 7 — Command console (scoped down)

The original idea (`focus()`, `takeSnapshot()`, toggle dark mode, `triggerEvent()`) is mostly
already covered: dark mode toggle landed with Feature 3, undo/redo (a `move()`+`restoreSnapshot()`
pair, closely related to `takeSnapshot()`) landed with Feature 6. What's left is two buttons -
**Focus** (Format State tab) and **Take Snapshot** (Snapshots tab) - each a direct, unadorned
`IEditor` call (`editor.focus()` / `editor.takeSnapshot()`).

Deliberately **not** built: a generic `triggerEvent()` console. Building a safe UI for it means
constructing a valid `PluginEventData<T>` payload per event type (30+ types, each with different
required fields - see `PluginEventType.ts`), which is real design work for a "lowest priority" item,
and a generic free-text event dispatcher risks letting someone post malformed events into their own
app's plugins. Not worth it unless a concrete use case for it shows up.

### Feature 8 — Snapshots tab (reversing the earlier non-goal)

The backlog originally called a full snapshot list infeasible: the public `SnapshotsManager`
interface only exposes relative movement (`canMove`/`move`), not the underlying array - there's no
`getSnapshots()`. That's still true, but it turns out not to matter:
[`SnapshotsManagerImpl.move()`](https://github.com/microsoft/roosterjs/blob/master/packages/roosterjs-content-model-core/lib/corePlugin/undo/SnapshotsManagerImpl.ts)
only does `this.snapshots.currentIndex += step` and returns the snapshot at the new index - it
never touches editor content. Only `editor.restoreSnapshot()` does that, and the library always
calls them as two separate, deliberate steps (see `undo.ts`/`redo.ts` above). So `move()` alone is
a safe, non-destructive way to walk the stack.

- **Agent**: `enumerateSnapshots(editor)` walks back to the start (`move(-1)` while `canMove(-1)`,
  counting steps), captures the start (`move(0)` - a documented no-op step that still returns the
  snapshot at the current index), walks forward to the end (`move(1)` while `canMove(1)`,
  collecting each one), then walks back to the original index (a single `move(delta)`). Each
  snapshot is summarized (`summarizeSnapshot`) into a JSON-safe object: HTML capped at 100000 chars
  (a safety net, not a display truncation - see Feature 9 below for why it needs to be the real
  content, not a short preview), `isDarkMode`, the real `selection`/`logicalRootPath` values
  (already plain JSON-safe data - path arrays and id strings, no DOM refs - so no reason to reduce
  them to booleans), and boolean flags only for `entityStates`/`additionalState` (which the copy/
  paste format in Feature 9 deliberately doesn't carry, matching the demo's scope).
  `getCurrentSnapshotIndex()` is the same walk-to-start-and-back trick without the collection, used
  by `applySnapshotAt()` to find its bearings before computing a relative `move(delta)` to an
  absolute target index. The only observable side effect on the host page during any of this is its
  own snapshot-`onChanged` listeners (if any) firing a few extra times as the index moves back and
  forth - settles back to the correct state by the end, and nothing here ever calls
  `restoreSnapshot()` mid-walk.
- Fetched **on demand** (opening the tab, or its Refresh button) rather than kept continuously live
  like the other tabs - walking the whole stack on every keystroke-triggered `contentChanged` would
  be wasteful and would spam the host page's `onChanged` listeners for no reason when the tab isn't
  even open.
- **Apply a listed snapshot**: `applySnapshotAt(targetIndex)` - find the current index, `move()` by
  the delta to the target, `editor.focus()` + `editor.restoreSnapshot()`. Identical to the demo
  `SnapshotPlugin.onMove`'s `move()` + `onRestoreSnapshot()` pair, just driven by an absolute index
  (what the panel has, from the last enumeration) instead of a relative step.
- **Apply pasted/typed HTML**: `applyHtml(html, selection, isDarkMode, logicalRootPath)` builds a
  `Snapshot` from whatever the panel parsed out (see Feature 9) and calls `editor.restoreSnapshot()`
  directly - the same call the demo's "Restore snapshot" button makes, confirmed safe by reading
  `restoreSnapshotSelection`/`restoreSnapshotLogicalRoot`/`restoreSnapshotColors`: all three handle
  their respective `Snapshot` field being absent by simply skipping that step, so plain HTML with no
  metadata still works (falls back to the editor's current `isDarkMode()`). Deliberately does
  **not** touch the snapshot stack (no `addSnapshot`/`move`) - it's a live content replacement, not
  a new undo checkpoint, matching what "paste and apply" should mean; Take Snapshot afterward
  checkpoints it if wanted.

### Feature 9 — Copy/paste a snapshot with selection metadata

Requested as a follow-up: the demo's `SnapshotPane` can copy a snapshot as HTML plus a trailing
`<!--{...}-->` comment holding its selection (and `isDarkMode`/`logicalRootPath`), and paste that
same format back in. Since `Snapshot.selection`/`logicalRootPath` were already being forwarded as
plain JSON-safe data (Feature 8), this needed no agent-side selection logic of its own - it's
string formatting/parsing plus wiring the already-existing fields through `applyHtml`'s now-widened
signature.

- **Copy** (`snapshotCopyText()` in `panel.js`): `snapshot.html + '<!--' + JSON.stringify({
  ...snapshot.selection, isDarkMode: snapshot.isDarkMode, logicalRootPath: snapshot.logicalRootPath
  }) + '-->'` - the exact format `SnapshotPane.onCopy`/`snapshotToString` produce. Synchronous,
  client-side only: since the panel already has the *full*, untruncated HTML and metadata for every
  listed snapshot from the last `enumerateSnapshots()` response (no per-click round trip to the
  agent needed), `navigator.clipboard.writeText()` runs directly inside the click handler - same
  call stack as the click, no `postMessage` round trip in between that could let the click's
  transient user-activation expire before the write.
- **Paste** (`parseSnapshotText()` in `panel.js`): inverse of the above - `lastIndexOf('<!--')` +
  `endsWith('-->')` to find the comment (same detection `SnapshotPane.onPaste` uses), `JSON.parse`
  the middle, pull `isDarkMode`/`logicalRootPath` out of the parsed object and treat whatever's left
  as `selection`. Falls back to treating the whole input as plain HTML with no metadata if there's
  no comment, or if the comment doesn't parse as JSON - never throws, never blocks a plain-HTML
  paste. Done at Apply-click time, not on the native `paste` event - simpler than intercepting the
  event (the demo does, to split into separate fields), and equally effective for a single textarea:
  the user sees exactly what will be sent before clicking Apply.
- Selection restoration is inherently best-effort even in the real library: `restoreSnapshotSelection`
  wraps everything in `try {} catch {}` ("might fail if the selection is not present, but we do not
  want to crash") since the path was recorded against a specific HTML structure - if that HTML was
  hand-edited before Apply, the path may no longer resolve. Worst case it's silently skipped, same
  as it would be for the library's own undo/redo.
- **Panel**: snapshot rows (newest first, current one marked, non-current ones get an Apply
  button - not the whole row, to avoid an accidental click changing live content), a paste-HTML
  textarea + Apply button with an explanatory hint, and the Undo/Redo/Take Snapshot buttons moved
  in from the Format State tab.

## Non-goals for now

- A generic `triggerEvent()` command console — see Feature 7 above.
- Most of the demo's other playground panes (paste simulation, entity insertion, custom containers,
  find/replace) are demo-specific test sandboxes, not generic-page inspection tools, so they stay
  out of the extension.
