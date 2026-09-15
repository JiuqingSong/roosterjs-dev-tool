# RoosterJS DevTools

A developer tool for inspecting the **Content Model** of [RoosterJS](https://github.com/microsoft/roosterjs)
editors on a page, inspired by React DevTools.

This repo doesn't contain RoosterJS itself - it's a separate tool that talks to any RoosterJS
editor on a page through a small public hook the editor core publishes (see below). It was
originally developed inside the roosterjs monorepo's `devtools/` folder and later extracted here
once it had no remaining dependency on that repo's source or build tooling.

There are two ways to use it:

- **`extension/`** - a real Chrome DevTools extension (a "Content Model" panel). Recommended.
- **`roosterjs-devtools-agent.js`** - a single console script for quick, no-install use.

## How it works

The editor core publishes a small global hook. The contract is public and versioned: the
`RoosterJsDevToolsHook` interface is exported from `roosterjs-content-model-types`, and the current
contract version from `RoosterJsDevToolsHookVersion` in `roosterjs-content-model-core`.

- On creation, every `Editor` pushes itself onto `window.__ROOSTERJS_DEVTOOLS_EDITORS__`, stamps
  `window.__ROOSTERJS_DEVTOOLS_HOOK__.version`, and calls `onEditorCreated(editor)`.
- For every plugin event it calls `onPluginEvent(editor, event)`.
- On disposal it removes itself and calls `onEditorDisposed(editor)`.

A tool installs the hook to receive notifications and discover existing editors. This mirrors React
DevTools' `__REACT_DEVTOOLS_GLOBAL_HOOK__` pattern - the library only detects and calls the hook;
all tool logic lives in the tool. Because the contract ships in the published `roosterjs` packages,
any site built with a recent enough RoosterJS is inspectable, not just a specific demo.

## Load the extension

1. Open a page built with a RoosterJS version that includes the devtools hook. If you're working
   against the [roosterjs](https://github.com/microsoft/roosterjs) repo itself, its demo app
   (`yarn start` there) is the easiest target; any other RoosterJS-based app works too.
2. In Chrome go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and
   select this repo's `extension` folder.
3. Open the RoosterJS page, open DevTools (F12), and pick the **Content Model** tab.
4. The panel has six tabs: **Model**, **Events**, **Selection**, **Format State**, **HTML**, and
   **Snapshots**. Use the dropdown to switch editor instances; all tabs follow whichever editor is
   selected.

### Model tab

Shows the model of the selected editor as a collapsible `<details>` tree. Refreshes live as you
type, change selection, or apply formatting.

Interactions:

- **Hover a node** → highlights the matching DOM element in the editor.
- **Click a node** → selects it in the editor (reverse of inspect).
- **Inspect button (◎)** → click it, then hover/click an element in the editor to reveal and flash
  its node in the tree (like React DevTools' inspector). Press Esc to cancel.
- **Selection sync** → moving the caret/selection in the editor highlights the corresponding node in
  the panel and keeps it scrolled into view.
- **Edit a format value** → each entry under a node's format is an input. Change it and press Enter
  (or blur) to write it back to the editor via `formatContentModel` (with an undo snapshot). Clear
  the input to remove that format. Only a node's own `format` is editable today; `segmentFormat`,
  list `levels`, and adding new keys are not yet supported.
- **`{ }` button** → toggles the Model tab between the interactive tree and a read-only dump of the
  raw Content Model as JSON (real field names - `blockGroupType`, `segments`, etc. - unlike the
  tree's display-renamed labels), for pasting into a bug repro. Fetched fresh each time you toggle
  it on, or when you hit Refresh while it's open.

### Events tab

A live log of `PluginEvent`s dispatched by the selected editor (the same feed the hook forwards via
`onPluginEvent`), newest first. Each entry expands to type-specific details (key pressed, mouse
button, paste content types, entity operation, etc.). The "Show item count" dropdown controls how
much of the buffered log is displayed (the agent keeps the last 100 events per editor regardless, so
switching editors or reopening the panel doesn't lose recent history); "Clear all" empties that
editor's buffer.

### Selection tab

Shows the editor's current `DOMSelection`: for a text selection, the collapsed/reverted state,
selected text preview, and start/end points (node kind, offset, text preview); for an image
selection, the image's tag and `src`; for a table selection, the first/last row and column. Updates
live on `selectionChanged` and after content changes.

### Format State tab

Two sections:

- **Editor State** - dark mode (with a checkbox to toggle it live via `setDarkModeState()`), a
  Focus button (`editor.focus()`), `hasFocus`, `isInShadowEdit`, `canUndo`/`canRedo`, environment
  flags (`isMac`/`isAndroid`/`isIOS`/`isSafari`/`isMobileOrTablet`/`isTouchSupported`), and enabled
  experimental features.
- **Format at Cursor** - the merged format at the current selection (bold/italic/underline/
  strikethrough/sub/superscript, font name/size, colors, line height/letter spacing, heading level,
  list/blockquote/table-cell context, link/image presence). A key is omitted when the selection
  spans content with conflicting values for it (e.g. bold text and non-bold text both selected).

This can't call the real `getFormatState()` - that API lives in `roosterjs-content-model-api`,
a package layer above the one the hook lives in, unreachable from a content script. Instead the
agent ports the same merge algorithm (`retrieveModelFormatState` in `roosterjs-content-model-dom`)
client-side, computed from data already public on `IEditor` (see the "Format state" comment block
at the top of `injected-agent.js` for exactly which edge cases this simplified port skips - none of
them affect the common "what's the format at my cursor" case this tab exists for).

### HTML tab

A read-only, live view of the editor content div's `innerHTML`, via `DOMHelper.getClonedRoot()` (a
deep clone into a detached document, so reading it never touches the live editor DOM). Updates on
the same cadence as the Model tab.

### Snapshots tab

The full undo/redo stack, similar to the roosterjs demo's `SnapshotPane`. Fetched on demand (opening
the tab, or the Refresh button) rather than kept continuously live, since building the list walks
the whole stack - see below.

- **The list** - every snapshot in the stack (past and "redo" future), newest first, with the
  current one marked. Each shows a truncated HTML preview, its character count, and flags for
  `isDarkMode`/`selection`/`hasEntityStates`/`hasAdditionalState`/`logicalRoot`. Click **Apply** on
  any non-current one to jump straight to it (`editor.focus()` + `editor.restoreSnapshot()` at that
  position - the same pair the demo's `SnapshotPlugin.onMove` uses for its double-click-to-restore).
  Click **Copy** on any row (including the current one) to copy its HTML plus a trailing
  `<!--{...}-->` comment holding its selection/dark mode/logical root - the exact same format the
  demo's `SnapshotPane` "Copy snapshot with metadata" button produces.
- **Undo/Redo/Take Snapshot** buttons.
- **Apply custom HTML as new content** - paste or type HTML and click Apply to set it as the
  editor's live content directly. Paste text produced by the Copy button above (HTML + a trailing
  metadata comment) and the selection/dark mode/logical root come back too, not just the HTML -
  `editor.restoreSnapshot({ html, selection, isDarkMode, logicalRootPath })`, same call the demo's
  "Restore snapshot" button makes for a pasted snapshot. Plain HTML with no comment still works,
  applying just the content with the editor's current dark mode state. Either way this does *not*
  itself add an undo checkpoint - it's a content replacement, not a new stack entry - so click Take
  Snapshot afterward if you want the pasted state to become one.

**How the list is even possible.** The public `SnapshotsManager` interface only exposes relative
movement (`canMove`/`move`), not the underlying array - by design, there's no `getSnapshots()`.
But `move(step)` turns out to only move an internal index and return the snapshot there; it never
touches editor content (only `editor.restoreSnapshot()` does that - `move()` and `restoreSnapshot()`
are deliberately separate calls, which is also how the library's own `undo`/`redo` commands use
them). So the agent walks the whole stack - back to the start, forward to the end, collecting every
snapshot along the way - then walks back to the original position, all without ever calling
`restoreSnapshot()`. The editor's real content is never touched during the walk; the only
observable side effect on the host page is its own snapshot-changed listeners (if any) firing a few
extra times as the internal index moves back and forth, settling back to the correct state by the
end.

Requires Chrome 111+ (the extension injects a MAIN-world content script).

### How the pieces fit

```
injected-agent.js (MAIN world)  --window.postMessage-->  content-script.js (ISOLATED)
   installs hook, serializes,                                 |  chrome.runtime
   draws highlight overlay                                    v
                                                       background.js (routes by tabId)
                                                              |  port
                                                              v
                              panel.js  (Model / Events / Selection / Format State / HTML / Snapshots tabs)
```

Only JSON-safe data crosses the boundary; live DOM references stay in the agent, which is why the
highlight overlay is drawn in the page rather than the panel.

## Automated end-to-end test

`test/run-e2e.js` loads the **real** extension into a
[Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) instance (regular Chrome
137+ disables the `--load-extension` switch, but Chrome for Testing still honors it) and drives the
whole pipeline over the DevTools Protocol:

```
library hook -> MAIN-world agent -> ISOLATED content script -> background -> panel
```

It asserts: content scripts inject, the editor is discovered and serialized to a `Document` tree,
the panel renders it through the real messaging path, typing live-updates the Model tab via the
`onPluginEvent` feed, that feed also populates the Events tab (and "Clear all" empties it), the
Selection tab reflects the resulting caret, the Format State tab derives a cursor format from it,
the dark mode toggle round-trips through the real `editor.setDarkModeState()`, the HTML tab shows
live source, the `{ }` toggle shows raw Content Model JSON, the Snapshots tab lists the stack with
the current entry marked, Undo reverts an edit and Apply jumps to a specific snapshot (both through
the real snapshot/restore path), pasting HTML applies it as new content, Take Snapshot then adds
that pasted content as a checkpoint, Copy includes selection metadata in its trailing comment and
pasting that copy back in restores the exact selection (not just the HTML), and Focus calls
`editor.focus()`. (The panel runs in standalone mode for the test, so the only line not exercised is
`chrome.devtools.panels.create`.)

```
npm install
npm test
```

This needs a **RoosterJS page to test against** - it doesn't bundle one. By default it looks for
one already running at `http://localhost:3000/` (a natural fit if you happen to have the roosterjs
repo's demo running via `yarn start` there); if nothing answers, it prints a clear error rather than
guessing. Point it elsewhere, or have it start your own dev server, with:

- `DEMO_URL=<url>` - the page to test against (default `http://localhost:3000/`).
- `DEMO_READY_PATH=<path>` - URL path appended to `DEMO_URL` to probe readiness (default
  `scripts/demo.js`, matching the roosterjs demo's build output - override if testing a different
  app's fixture page).
- `DEMO_START_CMD=<cmd>` / `DEMO_START_CWD=<dir>` - command (and working directory) to auto-start a
  dev server if `DEMO_URL` isn't already reachable, e.g.
  `DEMO_START_CMD="yarn start" DEMO_START_CWD=/path/to/roosterjs npm test`.
- `CFT_PATH=<chrome.exe>` - override the Chrome for Testing binary. If none is found, run
  `npx @puppeteer/browsers install chrome@stable` once and set this to the printed path.
- `HEADLESS=1` - run without a visible window.

See the header comment in `test/run-e2e.js` for the full details.

## Try it via the console script (no install)

1. Open any page built with a RoosterJS version that includes the devtools hook.
2. Open DevTools, and paste the entire contents of `roosterjs-devtools-agent.js` into the console.
3. A floating panel appears (top-right) showing the Content Model as a collapsible `<details>`
   tree. Use the dropdown to switch between editor instances; hover a node to highlight the matching
   DOM element in the editor.

The panel auto-refreshes on selection/typing in the focused editor. Helpers:

- `window.__roosterjsDevtools.refresh()` - force a refresh
- `window.__roosterjsDevtools.editors()` - list discovered editors
- `window.__roosterjsDevtools.detach()` - remove the panel and hook

## Known limitations (future phases)

- **Editing scope.** Two-way editing covers a node's own `format`; `segmentFormat`, list `levels`,
  decorators, and adding brand-new format keys are not editable yet.
- **Single document / top frame.** Editors in a popped-out window or a cross-origin iframe register
  on that frame's globals; the panel currently follows the inspected top window.
- **Element mapping (hover/inspect/click-to-select) needs the editor's element cache.** It maps
  Content Model nodes to DOM via the editor's `cachedElement` references, which are present during
  normal editor-driven interaction. Mutating the editor's DOM or selection from outside the editor
  can drop those references until the next editor-driven update; the tree still renders, but
  highlight/inspect/select may be unavailable for those nodes.
- The console script (`roosterjs-devtools-agent.js`) still uses DOM-based change detection
  (`selectionchange` + `input`); the extension uses the richer plugin-event feed.

## Design notes

- **Zero dependency on RoosterJS source or build tooling.** The extension and the console script
  have no `import`/`require` of anything - they only talk to a page through the public, versioned
  `RoosterJsDevToolsHook` global contract (`window.__ROOSTERJS_DEVTOOLS_HOOK__` /
  `window.__ROOSTERJS_DEVTOOLS_EDITORS__`). That's what makes this repo standalone: it works against
  any page built with a recent enough RoosterJS, and needs nothing from the roosterjs repo itself
  except a page to point at.
- `test/run-e2e.js`'s `ws` dependency is declared in this repo's own `package.json` rather than
  assumed to be available some other way - `npm install` here is self-contained.
- See `PLAN.md` for the feature history and the design reasoning behind each tab, including a couple
  of spots where a feature that first looked infeasible (a full snapshot list; deriving format state
  without the internal API for it) turned out to be possible after digging into how the underlying
  public APIs actually behave.
