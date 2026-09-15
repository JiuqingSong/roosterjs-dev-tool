// DevTools panel UI. Connects to the background service worker, requests the Content Model of the
// inspected page's editors, and renders it as a <details> tree. Hovering a node asks the page
// agent to highlight the matching DOM element.
//
// Runs in two modes:
//   - DevTools panel: tabId comes from chrome.devtools.inspectedWindow.tabId.
//   - Standalone (opened as a normal tab, e.g. for tests/debugging): tabId comes from a ?tabId=
//     query param, or the first http(s) tab is auto-selected.

(function () {
    'use strict';

    var pickerEl = document.getElementById('picker');
    var refreshEl = document.getElementById('refresh');
    var inspectEl = document.getElementById('inspect');
    var treeEl = document.getElementById('tree');
    var statusEl = document.getElementById('status');
    var eventsListEl = document.getElementById('eventsList');
    var eventsCountEl = document.getElementById('eventsCount');
    var eventsClearEl = document.getElementById('eventsClear');
    var selectionEl = document.getElementById('selection');
    var formatStateBodyEl = document.getElementById('formatStateBody');
    var darkModeToggleEl = document.getElementById('darkModeToggle');
    var undoBtnEl = document.getElementById('undoBtn');
    var redoBtnEl = document.getElementById('redoBtn');
    var focusBtnEl = document.getElementById('focusBtn');
    var takeSnapshotBtnEl = document.getElementById('takeSnapshotBtn');
    var jsonToggleEl = document.getElementById('jsonToggle');
    var htmlEl = document.getElementById('html');
    var snapshotListEl = document.getElementById('snapshotList');
    var snapshotsRefreshEl = document.getElementById('snapshotsRefresh');
    var snapshotHtmlInputEl = document.getElementById('snapshotHtmlInput');
    var applyHtmlBtnEl = document.getElementById('applyHtmlBtn');

    var port = null;
    var editorsState = [];
    var currentEditorId = null;
    var inspecting = false;
    var inDevTools = !!(chrome.devtools && chrome.devtools.inspectedWindow);
    var eventEntries = [];
    var eventsDisplayCount = parseInt(eventsCountEl.value, 10);
    var lastTree = null;
    var lastTreeError = null;
    var showJson = false;

    resolveTabId(function (tabId) {
        if (tabId == null) {
            treeEl.innerHTML = '';
            var msg = document.createElement('div');
            msg.className = 'empty';
            msg.textContent = 'No page to inspect.';
            treeEl.appendChild(msg);
            return;
        }
        start(tabId);
    });

    function resolveTabId(cb) {
        if (inDevTools) {
            cb(chrome.devtools.inspectedWindow.tabId);
            return;
        }
        var param = new URLSearchParams(location.search).get('tabId');
        if (param) {
            cb(parseInt(param, 10));
            return;
        }
        if (chrome.tabs && chrome.tabs.query) {
            chrome.tabs.query({}, function (tabs) {
                var t = (tabs || []).filter(function (x) {
                    return /^https?:/.test(x.url || '');
                })[0];
                cb(t ? t.id : null);
            });
            return;
        }
        cb(null);
    }

    function start(tabId) {
        port = chrome.runtime.connect({ name: 'panel' });
        port.postMessage({ type: 'connect', tabId: tabId });

        port.onMessage.addListener(function (message) {
            if (message.type === 'editors') {
                editorsState = message.editors || [];
                currentEditorId = message.currentEditorId;
                renderPicker();
                updateStatus();
            } else if (message.type === 'model') {
                lastTree = message.tree;
                lastTreeError = message.error;
                if (!showJson) {
                    renderTree(message.tree, message.error);
                }
            } else if (message.type === 'rawJson') {
                renderJson(message.json, message.error);
            } else if (message.type === 'html') {
                renderHtml(message.html, message.error);
            } else if (message.type === 'events') {
                eventEntries = message.entries || [];
                renderEvents();
            } else if (message.type === 'selection') {
                renderSelection(message.selection);
            } else if (message.type === 'formatState') {
                renderFormatState(message.state);
            } else if (message.type === 'snapshots') {
                renderSnapshots(message.currentIndex, message.snapshots || [], message.error);
            } else if (message.type === 'inspectHover') {
                previewNode(message.nodeId);
            } else if (message.type === 'inspectPick') {
                setInspecting(false);
                revealNode(message.nodeId);
            } else if (message.type === 'inspectStopped') {
                setInspecting(false);
            }
        });

        port.postMessage({ type: 'init' });

        // After the inspected page navigates/reloads, the agent re-injects fresh; re-sync.
        if (inDevTools && chrome.devtools.network && chrome.devtools.network.onNavigated) {
            chrome.devtools.network.onNavigated.addListener(function () {
                editorsState = [];
                currentEditorId = null;
                eventEntries = [];
                lastTree = null;
                lastTreeError = null;
                showJson = false;
                jsonToggleEl.classList.remove('active');
                renderPicker();
                renderTree(null);
                renderEvents();
                renderSelection(null);
                renderFormatState(null);
                renderHtml(null);
                renderSnapshots(-1, []);
                setTimeout(function () {
                    port.postMessage({ type: 'init' });
                }, 300);
            });
        }

        pickerEl.addEventListener('change', function () {
            currentEditorId = parseInt(pickerEl.value, 10);
            port.postMessage({ type: 'selectEditor', editorId: currentEditorId });
        });

        refreshEl.addEventListener('click', function () {
            port.postMessage({ type: 'refresh' });
            if (showJson) {
                port.postMessage({ type: 'getRawJson' });
            }
        });

        jsonToggleEl.addEventListener('click', function () {
            showJson = !showJson;
            jsonToggleEl.classList.toggle('active', showJson);
            if (showJson) {
                treeEl.innerHTML = '';
                var loading = document.createElement('div');
                loading.className = 'empty';
                loading.textContent = 'Loading JSON…';
                treeEl.appendChild(loading);
                port.postMessage({ type: 'getRawJson' });
            } else {
                renderTree(lastTree, lastTreeError);
            }
        });

        undoBtnEl.addEventListener('click', function () {
            port.postMessage({ type: 'moveSnapshot', step: -1 });
        });

        redoBtnEl.addEventListener('click', function () {
            port.postMessage({ type: 'moveSnapshot', step: 1 });
        });

        focusBtnEl.addEventListener('click', function () {
            port.postMessage({ type: 'focusEditor' });
        });

        takeSnapshotBtnEl.addEventListener('click', function () {
            port.postMessage({ type: 'takeSnapshot' });
        });

        snapshotsRefreshEl.addEventListener('click', function () {
            port.postMessage({ type: 'getSnapshots' });
        });

        applyHtmlBtnEl.addEventListener('click', function () {
            var parsed = parseSnapshotText(snapshotHtmlInputEl.value);
            port.postMessage({
                type: 'applyHtml',
                html: parsed.html,
                selection: parsed.selection,
                isDarkMode: parsed.isDarkMode,
                logicalRootPath: parsed.logicalRootPath,
            });
        });

        inspectEl.addEventListener('click', function () {
            var next = !inspecting;
            setInspecting(next);
            port.postMessage({ type: next ? 'startInspect' : 'stopInspect' });
        });

        treeEl.addEventListener('mouseover', function (ev) {
            var summary = ev.target.closest && ev.target.closest('[data-node-id]');
            if (summary) {
                port.postMessage({
                    type: 'highlight',
                    nodeId: parseInt(summary.getAttribute('data-node-id'), 10),
                });
            }
        });
        treeEl.addEventListener('mouseout', function () {
            port.postMessage({ type: 'clearHighlight' });
        });

        // Click a node to select it in the editor (reverse of inspect).
        treeEl.addEventListener('click', function (ev) {
            var summary = ev.target.closest && ev.target.closest('[data-node-id]');
            if (summary) {
                port.postMessage({
                    type: 'selectInEditor',
                    nodeId: parseInt(summary.getAttribute('data-node-id'), 10),
                });
            }
        });

        eventsCountEl.addEventListener('change', function () {
            eventsDisplayCount = parseInt(eventsCountEl.value, 10);
            renderEvents();
        });

        eventsClearEl.addEventListener('click', function () {
            port.postMessage({ type: 'clearEvents' });
        });

        darkModeToggleEl.addEventListener('change', function () {
            port.postMessage({ type: 'setDarkMode', value: darkModeToggleEl.checked });
        });
    }

    // ---- tabs ---------------------------------------------------------------
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var tab = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-btn').forEach(function (b) {
                b.classList.toggle('active', b === btn);
            });
            document.querySelectorAll('.tab-panel').forEach(function (panel) {
                panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tab);
            });
            // Snapshot enumeration walks the whole undo/redo stack (see injected-agent.js), so it's
            // fetched on demand rather than kept continuously live like the other tabs.
            if (tab === 'snapshots' && port) {
                port.postMessage({ type: 'getSnapshots' });
            }
        });
    });

    function setInspecting(on) {
        inspecting = on;
        inspectEl.classList.toggle('active', on);
    }

    // Mark a node as previewed while the inspect cursor hovers its element in the editor.
    function previewNode(nodeId) {
        var prev = treeEl.querySelector('.hover-preview');
        if (prev) {
            prev.classList.remove('hover-preview');
        }
        var summary = treeEl.querySelector('[data-node-id="' + nodeId + '"]');
        if (summary) {
            summary.classList.add('hover-preview');
        }
    }

    // Expand ancestors, scroll to, and flash a node (used by inspect-pick).
    function revealNode(nodeId) {
        var summary = treeEl.querySelector('[data-node-id="' + nodeId + '"]');
        if (!summary) {
            return;
        }
        var el = summary.parentElement;
        while (el && el !== treeEl) {
            if (el.tagName === 'DETAILS') {
                el.open = true;
            }
            el = el.parentElement;
        }
        summary.scrollIntoView({ block: 'nearest' });
        summary.classList.add('picked');
        window.__rjsdtLastPick = nodeId;
        setTimeout(function () {
            summary.classList.remove('picked');
        }, 1500);
    }

    function updateStatus() {
        statusEl.textContent = editorsState.length + ' editor(s)';
    }

    function renderPicker() {
        pickerEl.innerHTML = '';
        editorsState.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = String(e.id);
            opt.textContent = '#' + e.id + ' ' + e.label;
            opt.selected = e.id === currentEditorId;
            pickerEl.appendChild(opt);
        });
    }

    // ---- events tab -----------------------------------------------------------
    function renderEvents() {
        eventsListEl.innerHTML = '';

        var count = Math.min(eventEntries.length, eventsDisplayCount);
        var displayed = count > 0 ? eventEntries.slice(eventEntries.length - count) : [];
        displayed = displayed.slice().reverse();

        if (displayed.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No events yet.';
            eventsListEl.appendChild(empty);
            return;
        }

        displayed.forEach(function (entry) {
            eventsListEl.appendChild(renderEventEntry(entry));
        });
    }

    function renderEventEntry(entry) {
        var details = document.createElement('details');
        var summary = document.createElement('summary');

        var time = document.createElement('span');
        time.className = 'evt-time';
        time.textContent = new Date(entry.time).toLocaleTimeString();
        summary.appendChild(time);

        var type = document.createElement('span');
        type.className = 'evt-type';
        type.textContent = entry.eventType;
        summary.appendChild(type);

        details.appendChild(summary);

        if (entry.detail && Object.keys(entry.detail).length) {
            var detailEl = document.createElement('div');
            detailEl.className = 'evt-detail';
            Object.keys(entry.detail).forEach(function (key) {
                var value = entry.detail[key];
                if (value === undefined) {
                    return;
                }
                var row = document.createElement('div');
                row.className = 'evt-detail-row';
                var keyEl = document.createElement('span');
                keyEl.className = 'evt-detail-key';
                keyEl.textContent = key;
                var valEl = document.createElement('span');
                valEl.textContent =
                    typeof value === 'object' ? JSON.stringify(value) : String(value);
                row.appendChild(keyEl);
                row.appendChild(valEl);
                detailEl.appendChild(row);
            });
            details.appendChild(detailEl);
        }

        return details;
    }

    // ---- selection tab --------------------------------------------------------
    function renderSelection(selection) {
        selectionEl.innerHTML = '';

        if (!selection) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No selection.';
            selectionEl.appendChild(empty);
            return;
        }

        var wrap = document.createElement('div');
        wrap.className = 'kv-view';
        appendKvRows(wrap.appendChild(document.createElement('table')), Object.keys(selection), selection);
        selectionEl.appendChild(wrap);
    }

    // Render `keys` present in `values` as key/value rows into `table` (undefined values skipped).
    function appendKvRows(table, keys, values) {
        keys.forEach(function (key) {
            var value = values[key];
            if (value === undefined) {
                return;
            }
            var row = document.createElement('tr');
            var keyCell = document.createElement('td');
            keyCell.className = 'key';
            keyCell.textContent = key;
            var valCell = document.createElement('td');
            valCell.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
            row.appendChild(keyCell);
            row.appendChild(valCell);
            table.appendChild(row);
        });
    }

    // ---- format state tab -------------------------------------------------------
    var EDITOR_STATE_KEYS = [
        'isDarkMode',
        'hasFocus',
        'isInShadowEdit',
        'canUndo',
        'canRedo',
        'isMac',
        'isAndroid',
        'isIOS',
        'isSafari',
        'isMobileOrTablet',
        'isTouchSupported',
        'experimentalFeatures',
    ];

    function renderFormatState(state) {
        formatStateBodyEl.innerHTML = '';
        darkModeToggleEl.checked = !!(state && state.isDarkMode);

        if (!state) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No editor selected.';
            formatStateBodyEl.appendChild(empty);
            return;
        }

        var wrap = document.createElement('div');
        wrap.className = 'kv-view';

        var editorHeading = document.createElement('h4');
        editorHeading.textContent = 'Editor State';
        wrap.appendChild(editorHeading);
        appendKvRows(wrap.appendChild(document.createElement('table')), EDITOR_STATE_KEYS, state);

        var cursorHeading = document.createElement('h4');
        cursorHeading.textContent = 'Format at Cursor';
        wrap.appendChild(cursorHeading);

        var cursorKeys = Object.keys(state).filter(function (key) {
            return EDITOR_STATE_KEYS.indexOf(key) === -1;
        });
        if (cursorKeys.length === 0) {
            var none = document.createElement('div');
            none.className = 'empty';
            none.textContent = 'No selection in editor.';
            wrap.appendChild(none);
        } else {
            appendKvRows(wrap.appendChild(document.createElement('table')), cursorKeys, state);
        }

        formatStateBodyEl.appendChild(wrap);
    }

    // ---- snapshots tab ---------------------------------------------------------
    function renderSnapshots(currentIndex, list, error) {
        undoBtnEl.disabled = currentIndex <= 0;
        redoBtnEl.disabled = currentIndex < 0 || currentIndex >= list.length - 1;

        snapshotListEl.innerHTML = '';

        if (error) {
            var errEl = document.createElement('div');
            errEl.className = 'empty';
            errEl.textContent = 'Error: ' + error;
            snapshotListEl.appendChild(errEl);
            return;
        }

        if (list.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent =
                currentIndex < 0
                    ? 'No snapshots yet. Edit the editor or click Take Snapshot.'
                    : 'No editor selected.';
            snapshotListEl.appendChild(empty);
            return;
        }

        // Newest (highest index / most "redo") first, matching the demo's SnapshotPane order.
        for (var i = list.length - 1; i >= 0; i--) {
            snapshotListEl.appendChild(renderSnapshotItem(list[i], i, i === currentIndex));
        }
    }

    function renderSnapshotItem(snapshot, index, isCurrent) {
        var item = document.createElement('div');
        item.className = 'snapshot-item' + (isCurrent ? ' current' : '');

        var main = document.createElement('div');
        main.className = 'snapshot-item-main';

        var header = document.createElement('div');
        header.className = 'snapshot-item-header';

        var indexEl = document.createElement('span');
        indexEl.className = 'snapshot-index';
        indexEl.textContent = '#' + index;
        header.appendChild(indexEl);

        if (isCurrent) {
            var badge = document.createElement('span');
            badge.className = 'snapshot-current-badge';
            badge.textContent = '(current)';
            header.appendChild(badge);
        }

        var flags = [];
        if (snapshot.isDarkMode) flags.push('dark');
        if (snapshot.selection) flags.push('selection');
        if (snapshot.hasEntityStates) flags.push('entities');
        if (snapshot.hasAdditionalState) flags.push('additionalState');
        if (snapshot.logicalRootPath) flags.push('logicalRoot');
        if (flags.length) {
            var flagsEl = document.createElement('span');
            flagsEl.className = 'snapshot-flags';
            flagsEl.textContent = flags.join(', ');
            header.appendChild(flagsEl);
        }

        main.appendChild(header);

        var preview = document.createElement('pre');
        preview.className = 'snapshot-preview';
        preview.textContent = (snapshot.html || '(empty)') + ' ';
        var sizeNote = document.createElement('span');
        sizeNote.className = 'snapshot-flags';
        sizeNote.textContent = '[' + snapshot.htmlLength + ' chars]';
        preview.appendChild(sizeNote);
        main.appendChild(preview);

        item.appendChild(main);

        var actions = document.createElement('div');
        actions.className = 'snapshot-item-actions';

        var copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy HTML + selection/dark mode/logical root metadata (as a trailing HTML comment, like the demo\'s SnapshotPane)';
        copyBtn.addEventListener('click', function () {
            var text = snapshotCopyText(snapshot);
            var restoreLabel = function () {
                copyBtn.textContent = 'Copy';
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(restoreLabel, 1200);
                }, restoreLabel);
            }
        });
        actions.appendChild(copyBtn);

        if (!isCurrent) {
            var applyBtn = document.createElement('button');
            applyBtn.textContent = 'Apply';
            applyBtn.title = 'editor.focus() + editor.restoreSnapshot() at this position';
            applyBtn.addEventListener('click', function () {
                port.postMessage({ type: 'applySnapshot', index: index });
            });
            actions.appendChild(applyBtn);
        }

        item.appendChild(actions);

        return item;
    }

    // Same format as the demo's SnapshotPane.snapshotToString()/onCopy(): the HTML followed by a
    // trailing HTML comment holding the selection fields plus isDarkMode/logicalRootPath as JSON.
    // A plain HTML comment, so pasting it anywhere else (or back into a real editor) is harmless -
    // only this tab's "Apply custom HTML" parses it back out.
    function snapshotCopyText(snapshot) {
        var metadata = Object.assign({}, snapshot.selection || {}, {
            isDarkMode: snapshot.isDarkMode,
            logicalRootPath: snapshot.logicalRootPath,
        });
        return snapshot.html + '<!--' + JSON.stringify(metadata) + '-->';
    }

    // Inverse of snapshotCopyText(): splits trailing `<!--{...}-->` metadata off pasted/typed text,
    // same detection the demo's SnapshotPane.onPaste uses (last '<!--', text ends with '-->'). Falls
    // back to treating the whole input as plain HTML with no metadata if there's no comment, or if
    // it doesn't parse as JSON.
    function parseSnapshotText(text) {
        var idx = text.lastIndexOf('<!--');
        if (idx < 0 || !text.endsWith('-->')) {
            return { html: text, selection: null, isDarkMode: null, logicalRootPath: null };
        }
        try {
            var metadata = JSON.parse(text.substring(idx + 4, text.length - 3));
            var isDarkMode = typeof metadata.isDarkMode === 'boolean' ? metadata.isDarkMode : null;
            var logicalRootPath = metadata.logicalRootPath || null;
            delete metadata.isDarkMode;
            delete metadata.logicalRootPath;
            return {
                html: text.substring(0, idx),
                selection: Object.keys(metadata).length ? metadata : null,
                isDarkMode: isDarkMode,
                logicalRootPath: logicalRootPath,
            };
        } catch (e) {
            return { html: text, selection: null, isDarkMode: null, logicalRootPath: null };
        }
    }

    // ---- JSON toggle (shares the Model tab's #tree container) -----------------
    function renderJson(json, error) {
        if (!showJson) {
            return; // toggled off again before the response arrived
        }
        treeEl.innerHTML = '';
        var pre = document.createElement('pre');
        pre.className = 'code-view';
        pre.style.padding = '0';
        pre.textContent = error ? 'Error: ' + error : json || 'No editor selected.';
        treeEl.appendChild(pre);
    }

    // ---- HTML tab ---------------------------------------------------------------
    function renderHtml(html, error) {
        htmlEl.textContent = error
            ? 'Error: ' + error
            : html == null
            ? 'No editor selected.'
            : html || '(empty)';
    }

    function renderTree(tree, error) {
        // Test/debug observability: counts how many times the tree has been (re)rendered.
        window.__rjsdtRenderCount = (window.__rjsdtRenderCount || 0) + 1;

        treeEl.innerHTML = '';
        if (error) {
            var err = document.createElement('div');
            err.className = 'empty';
            err.textContent = 'Error: ' + error;
            treeEl.appendChild(err);
            return;
        }
        if (!tree) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent =
                'No editor found on this page. Make sure it is built with the devtools hook, then reload.';
            treeEl.appendChild(empty);
            return;
        }
        treeEl.appendChild(renderNode(tree));

        // Selection sync: keep the node at the caret/selection in view.
        var selected = treeEl.querySelector('summary.selected');
        if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
        }
    }

    function renderNode(node) {
        var details = document.createElement('details');
        details.open = node.hasSelection || node.isSelected;

        var summary = document.createElement('summary');
        summary.setAttribute('data-node-id', node.id);
        summary.className = node.isSelected
            ? 'selected'
            : node.hasSelection
            ? 'child-selected'
            : '';

        var title = document.createElement('span');
        title.className = 'title';
        title.textContent = node.title;
        summary.appendChild(title);

        if (node.subtitle) {
            var sub = document.createElement('span');
            sub.className = 'subtitle';
            sub.textContent = node.subtitle;
            summary.appendChild(sub);
        }

        details.appendChild(summary);

        if (node.format && Object.keys(node.format).length) {
            details.appendChild(renderFormat(node));
        }

        node.children.forEach(function (child) {
            details.appendChild(renderNode(child));
        });

        return details;
    }

    // Render a node's format as editable key/value rows. Editing a value (and pressing Enter or
    // blurring) writes it back to the editor via the agent.
    function renderFormat(node) {
        var wrap = document.createElement('div');
        wrap.className = 'format';

        Object.keys(node.format).forEach(function (key) {
            var value = node.format[key];
            var row = document.createElement('div');
            row.className = 'fmt-row';

            var keyEl = document.createElement('span');
            keyEl.className = 'fmt-key';
            keyEl.textContent = key;
            row.appendChild(keyEl);

            if (value !== null && typeof value === 'object') {
                var obj = document.createElement('span');
                obj.className = 'fmt-objval';
                obj.textContent = JSON.stringify(value);
                row.appendChild(obj);
            } else {
                var input = document.createElement('input');
                input.className = 'fmt-val';
                input.value = value == null ? '' : String(value);
                input.setAttribute('data-edit-node', node.id);
                input.setAttribute('data-key', key);
                input.setAttribute('data-type', typeof value);
                input.addEventListener('change', onFormatChange);
                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') {
                        input.blur();
                    }
                });
                row.appendChild(input);
            }

            wrap.appendChild(row);
        });

        return wrap;
    }

    function onFormatChange(e) {
        var input = e.target;
        port.postMessage({
            type: 'editFormat',
            nodeId: parseInt(input.getAttribute('data-edit-node'), 10),
            key: input.getAttribute('data-key'),
            value: input.value,
            valueType: input.getAttribute('data-type'),
        });
    }
})();
