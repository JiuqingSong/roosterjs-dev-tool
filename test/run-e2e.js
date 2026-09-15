/*
 * End-to-end test for the RoosterJS DevTools extension.
 *
 * Loads the *real* extension into a Chrome-for-Testing instance (which still honors
 * --load-extension, unlike Chrome 137+), opens the demo, and drives the whole pipeline:
 *
 *   library hook -> MAIN-world agent -> ISOLATED content script -> background -> panel
 *
 * It verifies content-script injection, editor discovery/serialization, background routing,
 * panel rendering, and the live onPluginEvent feed. The only piece not exercised is the trivial
 * chrome.devtools.panels.create registration (the panel runs in standalone mode here).
 *
 * Usage:   node devtools/test/run-e2e.js
 * Env:     CFT_PATH=<chrome.exe>     override the Chrome-for-Testing binary
 *          DEMO_URL=<url>            override the page to test against (default http://localhost:3000/)
 *          DEMO_READY_PATH=<path>    URL path appended to DEMO_URL to probe readiness (default scripts/demo.js)
 *          DEMO_START_CMD=<cmd>      command to auto-start a page at DEMO_URL if it isn't already up (default: yarn start)
 *          DEMO_START_CWD=<dir>      cwd to run DEMO_START_CMD in (default: the parent of this devtools/ folder,
 *                                    which is the roosterjs repo root when devtools/ lives inside it - see
 *                                    resolveDemoStartCwd() below)
 *          HEADLESS=1                run headless (default: headed)
 *
 * This file only depends on the extension living alongside it (../extension) and on some page at
 * DEMO_URL exposing the RoosterJsDevToolsHook contract - nothing else in this repo. That keeps
 * devtools/ extractable into its own repo (see devtools/PLAN.md): point DEMO_URL at any RoosterJS
 * page, or set DEMO_START_CMD/DEMO_START_CWD to however that repo starts one.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const DEVTOOLS_ROOT = path.resolve(__dirname, '..');
const EXT = path.join(DEVTOOLS_ROOT, 'extension');
const DEMO_URL = process.env.DEMO_URL || 'http://localhost:3000/';
const DEMO_READY_PATH = process.env.DEMO_READY_PATH || 'scripts/demo.js';
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- binary / server plumbing ----------------------------------------------
function resolveChrome() {
    if (process.env.CFT_PATH && fs.existsSync(process.env.CFT_PATH)) {
        return process.env.CFT_PATH;
    }
    const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(base)) {
        for (const dir of fs.readdirSync(base)) {
            const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(exe)) return exe;
        }
    }
    throw new Error(
        'No Chrome-for-Testing binary found. Install one with:\n' +
            '  npx @puppeteer/browsers install chrome@stable\n' +
            'then set CFT_PATH to the printed chrome.exe path.'
    );
}

function getJson(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
            let b = '';
            r.on('data', d => (b += d));
            r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
    });
}

function newTarget(url) {
    return new Promise((res, rej) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/json/new?' + url, method: 'PUT' },
            r => {
                let b = '';
                r.on('data', d => (b += d));
                r.on('end', () => res(JSON.parse(b)));
            }
        );
        req.on('error', rej);
        req.end();
    });
}

function httpStatus(url) {
    return new Promise(res => {
        http.get(url, r => {
            r.resume();
            res(r.statusCode);
        }).on('error', () => res(0));
    });
}

// The only spot in this file that assumes anything about the repo devtools/ currently lives in:
// a convenience default so `node devtools/test/run-e2e.js` just works inside the roosterjs
// monorepo (repo root = parent of devtools/) without extra setup. Fully overridable via
// DEMO_START_CWD/DEMO_START_CMD, and skipped entirely if DEMO_URL is already serving - so this
// file keeps working if devtools/ is ever extracted into its own repo.
function resolveDemoStartCwd() {
    if (process.env.DEMO_START_CWD) {
        return process.env.DEMO_START_CWD;
    }
    const candidate = path.resolve(DEVTOOLS_ROOT, '..');
    return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : null;
}

async function ensureDemoServer() {
    if ((await httpStatus(DEMO_URL + DEMO_READY_PATH)) === 200) {
        return null; // already running
    }

    const cwd = resolveDemoStartCwd();
    if (!cwd) {
        throw new Error(
            'No page is reachable at ' +
                DEMO_URL +
                ' and no dev server could be auto-started. Start one yourself and point DEMO_URL ' +
                'at it, or set DEMO_START_CMD (and DEMO_START_CWD if needed) to auto-start one.'
        );
    }

    const startCmd = process.env.DEMO_START_CMD || 'yarn start';
    console.log('Starting demo dev server (' + startCmd + ')...');
    const [cmd, ...cmdArgs] = startCmd.split(' ');
    const proc = spawn(cmd, cmdArgs, { cwd, shell: true, stdio: 'ignore' });
    for (let i = 0; i < 120; i++) {
        await sleep(1000);
        if ((await httpStatus(DEMO_URL + DEMO_READY_PATH)) === 200) {
            console.log('Demo server ready.');
            return proc;
        }
    }
    throw new Error('Demo dev server did not become ready in time.');
}

// ---- CDP session over a target's websocket ---------------------------------
function connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pend = new Map();
    const events = [];
    const ready = new Promise((res, rej) => {
        ws.on('open', res);
        ws.on('error', rej);
    });
    ws.on('message', m => {
        const o = JSON.parse(m);
        if (o.id && pend.has(o.id)) {
            pend.get(o.id)(o);
            pend.delete(o.id);
        } else if (o.method) {
            events.push(o);
        }
    });
    const send = (method, params) =>
        new Promise(r => {
            const i = ++id;
            pend.set(i, r);
            ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
    const evalIn = async (expr, contextId) => {
        const params = { expression: expr, returnByValue: true, awaitPromise: true };
        if (contextId != null) params.contextId = contextId;
        const r = await send('Runtime.evaluate', params);
        if (r.result && r.result.exceptionDetails) {
            throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails));
        }
        return r.result.result.value;
    };
    return {
        ready,
        send,
        events,
        eval: expr => evalIn(expr),
        evalContext: (contextId, expr) => evalIn(expr, contextId),
        close: () => ws.close(),
    };
}

async function pageSession(urlIncludes) {
    const targets = await getJson('/json');
    const t = targets.find(x => x.type === 'page' && (x.url || '').includes(urlIncludes));
    if (!t) throw new Error('page target not found: ' + urlIncludes);
    const s = connect(t.webSocketDebuggerUrl);
    await s.ready;
    await s.send('Runtime.enable');
    return s;
}

// Derive the unpacked extension id from our content script's own chrome.runtime.id, read in its
// isolated execution context on the demo page. Reliable and avoids chrome://extensions shadow DOM.
async function getExtensionIdFromPage(demo) {
    const contexts = demo.events
        .filter(e => e.method === 'Runtime.executionContextCreated')
        .map(e => e.params.context)
        .filter(c => c.auxData && c.auxData.type === 'isolated');
    for (const ctx of contexts) {
        try {
            const name = await demo.evalContext(
                ctx.id,
                'chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : null'
            );
            if (name === 'RoosterJS DevTools') {
                return await demo.evalContext(ctx.id, 'chrome.runtime.id');
            }
        } catch (e) {
            /* context may be gone; skip */
        }
    }
    return null;
}

// ---- main ------------------------------------------------------------------
(async () => {
    const chromePath = resolveChrome();
    console.log('Chrome-for-Testing: ' + chromePath);

    const demoProc = await ensureDemoServer();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rjsdt-e2e-'));
    const args = [
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + profile,
        '--load-extension=' + EXT,
        '--disable-extensions-except=' + EXT,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        DEMO_URL,
    ];
    if (process.env.HEADLESS === '1') args.unshift('--headless=new');
    const chrome = spawn(chromePath, args, { stdio: 'ignore' });

    const results = [];
    const check = (name, pass, detail) => {
        results.push(pass);
        console.log((pass ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' -> ' + detail : ''));
    };

    try {
        // wait for CDP
        for (let i = 0; i < 30; i++) {
            try {
                await getJson('/json/version');
                break;
            } catch (e) {
                await sleep(500);
            }
        }

        // demo page: content scripts injected for real (the real "extension loaded" signal)
        const demo = await pageSession('localhost:3000');
        let injected = false;
        for (let i = 0; i < 40; i++) {
            const ok = await demo.eval(
                "typeof window.__ROOSTERJS_DEVTOOLS_HOOK__==='object' && (window.__ROOSTERJS_DEVTOOLS_EDITORS__||[]).length>=1"
            );
            if (ok) {
                injected = true;
                break;
            }
            await sleep(500);
        }
        check('extension loaded: MAIN-world agent injected + editor registered', injected);
        if (!injected) throw new Error('extension content scripts did not inject; aborting');

        const version = await demo.eval('(window.__ROOSTERJS_DEVTOOLS_HOOK__||{}).version');
        check(
            'library stamps the public contract version on the hook',
            typeof version === 'number' && version >= 1,
            'version=' + version
        );

        const extId = await getExtensionIdFromPage(demo);
        check('ISOLATED content script present (extension id resolved)', !!extId, extId || 'unknown');
        if (!extId) throw new Error('could not resolve extension id; aborting');

        // panel (standalone) drives the full pipeline through background + content script + agent
        const panelTarget = await newTarget('chrome-extension://' + extId + '/panel.html');
        const panel = connect(panelTarget.webSocketDebuggerUrl);
        await panel.ready;
        await panel.send('Runtime.enable');

        let editorsText = '';
        let rendered = false;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            const optCount = await panel.eval('document.getElementById("picker").options.length');
            const treeText = await panel.eval('document.getElementById("tree").innerText');
            if (optCount >= 1 && /Document/.test(treeText)) {
                editorsText = await panel.eval(
                    'document.getElementById("picker").options[0].textContent'
                );
                rendered = true;
                break;
            }
        }
        check('panel renders Document tree via real messaging pipeline', rendered, editorsText);

        // Inspect and reverse-select are exercised first, while the editor's element references are
        // fresh. (Synthetic raw-DOM edits below would invalidate the editor's element cache, which
        // does not happen with real, editor-driven interaction.)

        // inspect: turn on inspect in the panel, click an element in the editor, expect a reveal
        await panel.eval("delete window.__rjsdtLastPick; document.getElementById('inspect').click()");
        await sleep(500);
        const pt = JSON.parse(
            await demo.eval(
                "(function(){var d=document.querySelector('[contenteditable=\\'true\\']');var el=d.querySelector('*')||d;var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+Math.min(6,r.width/2)),y:Math.round(r.top+Math.min(6,r.height/2))});})()"
            )
        );
        await demo.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
        await demo.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: pt.x,
            y: pt.y,
            button: 'left',
            clickCount: 1,
        });
        await demo.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: pt.x,
            y: pt.y,
            button: 'left',
            clickCount: 1,
        });
        let inspectOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            if ((await panel.eval('window.__rjsdtLastPick')) != null) {
                inspectOk = true;
                break;
            }
        }
        check('inspect: clicking an editor element reveals its node in the panel', inspectOk);

        // reverse select: clear the selection, click a node in the panel, expect the editor
        // selection to move into the editable
        await demo.eval('(function(){var s=getSelection();if(s)s.removeAllRanges();})()');
        const clicked = await panel.eval(
            "(function(){var ss=[].slice.call(document.querySelectorAll('#tree summary'));var p=ss.filter(function(s){return /Paragraph/.test(s.textContent);})[0]||ss[ss.length-1];if(p){p.click();return true;}return false;})()"
        );
        let reverseOk = false;
        if (clicked) {
            for (let i = 0; i < 20; i++) {
                await sleep(300);
                const inside = await demo.eval(
                    "(function(){var d=document.querySelector('[contenteditable=\\'true\\']');var s=getSelection();return !!(s&&s.anchorNode&&d.contains(s.anchorNode));})()"
                );
                if (inside) {
                    reverseOk = true;
                    break;
                }
            }
        }
        check('reverse select: clicking a node moves the editor selection into it', reverseOk);

        // live update + selection sync: type in the demo; the panel should update with the typed
        // text (onPluginEvent feed) and reflect the resulting caret as a selected node
        const marker = 'QZX' + Date.now().toString().slice(-4);
        const beforeCount = await panel.eval('window.__rjsdtRenderCount || 0');
        await demo.eval(
            "(function(){var d=document.querySelector('[contenteditable=\\'true\\']');d.focus();var s=getSelection();var r=document.createRange();r.selectNodeContents(d);r.collapse(false);s.removeAllRanges();s.addRange(r);})()"
        );
        await demo.send('Input.insertText', { text: marker });
        let liveOk = false;
        let selSync = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            const treeText = await panel.eval('document.getElementById("tree").innerText');
            const count = await panel.eval('window.__rjsdtRenderCount || 0');
            if (treeText.indexOf(marker) >= 0 && count > beforeCount) {
                liveOk = true;
                selSync =
                    (await panel.eval('document.querySelectorAll("#tree summary.selected").length')) >=
                    1;
                break;
            }
        }
        check('live update: typing re-renders panel via onPluginEvent', liveOk, 'marker=' + marker);
        check('selection sync: caret reflected as a selected node in the panel', selSync);

        // two-way edit: change the typed text node's fontFamily in the panel and confirm it is
        // written back through the editor to the DOM (formatContentModel returning true).
        const editState = await panel.eval(
            "(function(){var sums=[].slice.call(document.querySelectorAll('#tree summary'));var t=sums.filter(function(s){return /QZX/.test(s.textContent);})[0];if(!t)return 'no-text-node';var id=t.getAttribute('data-node-id');var input=document.querySelector('#tree .fmt-val[data-edit-node=\"'+id+'\"][data-key=\"fontFamily\"]');if(!input)return 'no-font-input';input.value='Verdana';input.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()"
        );
        let editOk = false;
        if (editState === 'ok') {
            for (let i = 0; i < 20; i++) {
                await sleep(300);
                const inDom = await demo.eval(
                    "/Verdana/i.test(document.querySelector('[contenteditable=\\'true\\']').innerHTML)"
                );
                if (inDom) {
                    editOk = true;
                    break;
                }
            }
        }
        check(
            'two-way edit: editing a node format writes back to the editor DOM',
            editOk,
            'state=' + editState
        );

        // events tab: the typing above fired real 'input'/'contentChanged' plugin events; the
        // Events tab (fed by the same onPluginEvent hook as the live-update check) should log them.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"events\"]').click()");
        await sleep(300);
        const eventsText = await panel.eval('document.getElementById("eventsList").innerText');
        check(
            'events tab: plugin events from typing appear in the log',
            /input|contentChanged|keyDown|keyPress/.test(eventsText),
            eventsText.slice(0, 120)
        );

        // events tab: "Clear all" asks the agent to drop its buffer and the panel reflects it.
        await panel.eval("document.getElementById('eventsClear').click()");
        let eventsCleared = false;
        for (let i = 0; i < 20; i++) {
            await sleep(200);
            const text = await panel.eval('document.getElementById("eventsList").innerText');
            if (/No events yet/.test(text)) {
                eventsCleared = true;
                break;
            }
        }
        check('events tab: Clear all empties the log', eventsCleared);

        // selection tab: the caret set during the live-update step is a range selection.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"selection\"]').click()");
        await sleep(300);
        const selectionText = await panel.eval('document.getElementById("selection").innerText');
        check(
            'selection tab: current DOM selection is shown',
            /range/.test(selectionText),
            selectionText.slice(0, 120)
        );

        // format state tab: typing set a text selection at the marker, so isBold/fontName/etc.
        // should be derivable, and the toggle at top should reflect + control dark mode.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"formatState\"]').click()");
        await sleep(300);
        const formatStateText = await panel.eval('document.getElementById("formatStateBody").innerText');
        check(
            'format state tab: cursor format is derived from the selection',
            /Format at Cursor/.test(formatStateText) && !/No selection in editor/.test(formatStateText),
            formatStateText.slice(0, 160)
        );

        // Toggling the checkbox sends 'setDarkMode' to the agent, which calls the real
        // editor.setDarkModeState() and pushes back a fresh formatState - confirm the round trip
        // via both the editor's own isDarkMode() and the panel checkbox reflecting it.
        const beforeDark = await demo.eval(
            '(window.__ROOSTERJS_DEVTOOLS_EDITORS__ || [])[0].isDarkMode()'
        );
        await panel.eval("document.getElementById('darkModeToggle').click()");
        let darkModeOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            const afterDark = await demo.eval(
                '(window.__ROOSTERJS_DEVTOOLS_EDITORS__ || [])[0].isDarkMode()'
            );
            const toggleChecked = await panel.eval("document.getElementById('darkModeToggle').checked");
            if (afterDark !== beforeDark && toggleChecked === afterDark) {
                darkModeOk = true;
                break;
            }
        }
        check('format state tab: dark mode toggle flips editor state', darkModeOk, 'before=' + beforeDark);
        // flip back so later runs (and the shared demo server) start from a known light-mode state
        if (darkModeOk) {
            await panel.eval("document.getElementById('darkModeToggle').click()");
            await sleep(300);
        }

        // HTML tab: live source of the editor content div, driven by the same refresh cadence as
        // the Model tab - the typed marker should show up in it.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"html\"]').click()");
        await sleep(300);
        const htmlText = await panel.eval('document.getElementById("html").textContent');
        check('html tab: shows live editor source', htmlText.includes(marker), htmlText.slice(0, 160));

        // JSON toggle: replaces the Model tab's tree with the raw Content Model, using real field
        // names (segmentType/blockType, not the tree's display-renamed ones).
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"model\"]').click()");
        await panel.eval("document.getElementById('jsonToggle').click()");
        let jsonText = '';
        let jsonOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            jsonText = await panel.eval('document.getElementById("tree").innerText');
            if (/"blockGroupType"\s*:\s*"Document"/.test(jsonText)) {
                jsonOk = true;
                break;
            }
        }
        check('json toggle: shows raw Content Model JSON', jsonOk, jsonText.slice(0, 160));
        // toggle back off so it doesn't leak into a later run reusing this profile/tab
        await panel.eval("document.getElementById('jsonToggle').click()");

        // Snapshots tab: enumerateSnapshots() walks the whole SnapshotsManager stack via move()
        // without ever calling restoreSnapshot() during the walk (see injected-agent.js), so it can
        // list snapshots a plain SnapshotsManager reference can't otherwise enumerate. There have
        // been at least two edits by now (typing the marker, the fontFamily two-way edit), so the
        // stack should have more than one entry with the current one marked.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"snapshots\"]').click()");
        let snapshotsText = '';
        let snapshotsListed = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            snapshotsText = await panel.eval('document.getElementById("snapshotList").innerText');
            if (/current/.test(snapshotsText) && /#\d/.test(snapshotsText)) {
                snapshotsListed = true;
                break;
            }
        }
        check(
            'snapshots tab: lists the snapshot stack with the current one marked',
            snapshotsListed,
            snapshotsText.slice(0, 160)
        );

        const undoEnabled = await panel.eval("!document.getElementById('undoBtn').disabled");
        check('snapshots tab: undo button is enabled after an edit', undoEnabled);
        const beforeUndoHtml = await demo.eval(
            "document.querySelector('[contenteditable=\\'true\\']').innerHTML"
        );
        await panel.eval("document.getElementById('undoBtn').click()");
        // Just confirm undo moved to a different snapshot (via the real snapshot/restore path) -
        // there were two edits before this, so one Undo click is only guaranteed to revert the
        // most recent of those, not both.
        let undoOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            const html = await demo.eval(
                "document.querySelector('[contenteditable=\\'true\\']').innerHTML"
            );
            if (html !== beforeUndoHtml) {
                undoOk = true;
                break;
            }
        }
        check('snapshots tab: Undo reverts the edit via the real snapshot path', undoOk);

        // Apply-by-index: clicking a non-current row's Apply button moves the manager's cursor to
        // that absolute index and restores it (editor.focus() + editor.restoreSnapshot()), the same
        // pair the demo's SnapshotPlugin.onMove uses for its double-click-to-restore.
        await panel.eval("document.getElementById('snapshotsRefresh').click()");
        await sleep(500);
        const beforeApplyHtml = await demo.eval(
            "document.querySelector('[contenteditable=\\'true\\']').innerHTML"
        );
        const applyClicked = await panel.eval(
            "(function(){var btns=[].slice.call(document.querySelectorAll('#snapshotList .snapshot-item button')).filter(function(b){return b.textContent==='Apply';});if(!btns.length)return false;btns[0].click();return true;})()"
        );
        let applyOk = false;
        if (applyClicked) {
            for (let i = 0; i < 20; i++) {
                await sleep(300);
                const html = await demo.eval(
                    "document.querySelector('[contenteditable=\\'true\\']').innerHTML"
                );
                if (html !== beforeApplyHtml) {
                    applyOk = true;
                    break;
                }
            }
        }
        check(
            'snapshots tab: Apply moves to and restores a specific snapshot',
            applyClicked && applyOk
        );

        // Paste HTML: editor.restoreSnapshot({html, isDarkMode}) applied directly, bypassing the
        // stack - exactly what the user asked for ("paste HTML as a single snapshot to apply").
        const pasteHtml = '<div>DEVTOOLS_PASTE_' + Date.now() + '</div>';
        await panel.eval(
            '(function(html){document.getElementById("snapshotHtmlInput").value = html;})(' +
                JSON.stringify(pasteHtml) +
                ')'
        );
        await panel.eval("document.getElementById('applyHtmlBtn').click()");
        let pasteOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            const html = await demo.eval(
                "document.querySelector('[contenteditable=\\'true\\']').innerHTML"
            );
            if (html.includes('DEVTOOLS_PASTE_')) {
                pasteOk = true;
                break;
            }
        }
        check('snapshots tab: pasted HTML is applied as new editor content', pasteOk);

        // Take Snapshot after the paste: the pasted content wasn't itself a stack entry (applyHtml
        // doesn't call addSnapshot), so this should add one and the list (auto-refreshed by the
        // agent's takeSnapshot handler) should now include it.
        const snapshotError = await panel.eval(
            "(function(){try{document.getElementById('takeSnapshotBtn').click();return null;}catch(e){return String(e);}})()"
        );
        let snapshotsAfterTake = '';
        let takeOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            snapshotsAfterTake = await panel.eval('document.getElementById("snapshotList").innerText');
            if (snapshotsAfterTake.includes('DEVTOOLS_PASTE_')) {
                takeOk = true;
                break;
            }
        }
        check(
            'snapshots tab: Take Snapshot adds the pasted content as a new checkpoint',
            snapshotError === null && takeOk,
            'error=' + snapshotError
        );

        // Selection round trip: editor.takeSnapshot() always records the current selection
        // (addUndoSnapshot.ts calls createSnapshotSelection() before reading innerHTML), so
        // selecting the pasted marker text, taking a snapshot, copying it (HTML + a trailing
        // <!--{...}--> comment, same format as the demo's SnapshotPane), moving the selection away,
        // then pasting that copy into "Apply custom HTML" should restore the exact selection - not
        // just the HTML.
        //
        // Set the selection and take the snapshot both within the demo page's own context (no hop
        // through the panel tab in between): roosterjs's selection tracking can reset on blur, and
        // clicking a button in the separate panel tab would blur the demo page between the two
        // steps. The panel's own Take Snapshot button is already covered by an earlier check.
        //
        // Collapse to the end of the marker div (selectNodeContents + collapse(false)) rather than
        // a hand-built spanning Range - the same pattern already used successfully elsewhere in this
        // file; a manually spanning Range over a lone text node hit a browser/harness selection-
        // normalization quirk unrelated to the feature under test.
        const markerText = pasteHtml.replace('<div>', '').replace('</div>', '');
        await demo.eval(
            "(function(){var d=document.querySelector('[contenteditable=\\'true\\']');d.focus();var inner=d.querySelector('div');var r=document.createRange();r.selectNodeContents(inner);r.collapse(false);var s=getSelection();s.removeAllRanges();s.addRange(r);(window.__ROOSTERJS_DEVTOOLS_EDITORS__||[])[0].takeSnapshot();})()"
        );
        await sleep(300);
        await panel.eval("document.getElementById('snapshotsRefresh').click()");
        await sleep(500);

        // Stub the clipboard so the check doesn't depend on OS clipboard access/permissions inside
        // the headless CDP session - only the text the Copy button would have written is captured.
        await panel.eval(
            "navigator.clipboard.writeText = function(t){ window.__rjsdtCopiedText = t; return Promise.resolve(); };"
        );
        const copyClicked = await panel.eval(
            "(function(){var item=document.querySelector('#snapshotList .snapshot-item.current');if(!item)return false;var btn=[].slice.call(item.querySelectorAll('button')).filter(function(b){return b.textContent==='Copy';})[0];if(!btn)return false;btn.click();return true;})()"
        );
        let copiedText = null;
        for (let i = 0; i < 20; i++) {
            await sleep(200);
            copiedText = await panel.eval('window.__rjsdtCopiedText || null');
            if (copiedText) break;
        }
        check(
            'snapshots tab: Copy includes selection metadata in the trailing comment',
            copyClicked && !!copiedText && /"type":"range"/.test(copiedText || ''),
            (copiedText || '(none)').slice(-200)
        );

        // Move the selection elsewhere so a later match proves the paste restored it, not that it
        // was just left alone.
        await demo.eval(
            "(function(){var d=document.querySelector('[contenteditable=\\'true\\']');d.focus();var s=getSelection();var r=document.createRange();r.selectNodeContents(d);r.collapse(true);s.removeAllRanges();s.addRange(r);})()"
        );

        await panel.eval(
            '(function(t){document.getElementById("snapshotHtmlInput").value = t;})(' +
                JSON.stringify(copiedText || '') +
                ')'
        );
        await panel.eval("document.getElementById('applyHtmlBtn').click()");
        // Confirm restoreSnapshotSelection() put the live cursor's anchor node back onto the exact
        // marker text node (not just that the HTML came back, and not left at the "moved away"
        // position). Not asserting the exact offset: SnapshotSelection's path encoding (getPath) is
        // relative to element child-indices, not text character offsets - collapse(false) on the
        // marker div lands the round-tripped cursor at a specific, self-consistent offset that isn't
        // markerText.length, which is an internal roosterjs encoding detail this feature just passes
        // through unchanged, not something this test needs to predict.
        let selectionRestored = false;
        let lastSelectionState = '';
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            lastSelectionState = await demo.eval(
                "(function(){var s=getSelection();return s&&s.anchorNode?(s.anchorNode.textContent||''):'no-selection';})()"
            );
            if (lastSelectionState === markerText) {
                selectionRestored = true;
                break;
            }
        }
        check(
            'snapshots tab: pasting a copied snapshot restores its selection, not just its HTML',
            !!copiedText && selectionRestored,
            lastSelectionState
        );

        // Focus: low-risk direct IEditor call, exercised end to end.
        await panel.eval("document.querySelector('.tab-btn[data-tab=\"formatState\"]').click()");
        await demo.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
        await panel.eval("document.getElementById('focusBtn').click()");
        let focusOk = false;
        for (let i = 0; i < 20; i++) {
            await sleep(200);
            if (await demo.eval('(window.__ROOSTERJS_DEVTOOLS_EDITORS__ || [])[0].hasFocus()')) {
                focusOk = true;
                break;
            }
        }
        check('format state tab: Focus button calls editor.focus()', focusOk);

        demo.close();
        panel.close();
    } finally {
        // cleanup
        try {
            const v = await getJson('/json/version');
            const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
            await new Promise(r => ws.on('open', r));
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            await sleep(500);
            ws.close();
        } catch (e) {
            try {
                chrome.kill();
            } catch (e2) {}
        }
        if (demoProc) {
            // we started the dev server; stop it
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/pid', String(demoProc.pid), '/T', '/F']);
            } else {
                demoProc.kill();
            }
        }
        try {
            fs.rmSync(profile, { recursive: true, force: true });
        } catch (e) {}
    }

    const failed = results.filter(p => !p).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
    process.exit(failed ? 1 : 0);
})().catch(e => {
    console.error('ERROR', e);
    process.exit(2);
});
