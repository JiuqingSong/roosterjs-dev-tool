/*
 * RoosterJS DevTools - MAIN-world agent.
 *
 * Runs in the page's JS context at document_start (before editors are created), installs the
 * devtools hook, serializes the Content Model of each editor on demand, and draws highlight
 * overlays. It owns the live DOM references; only JSON-safe data crosses to the DevTools panel.
 *
 * Communicates with the ISOLATED-world content script via window.postMessage.
 */
(function () {
    'use strict';

    var HOOK = '__ROOSTERJS_DEVTOOLS_HOOK__';
    var EDITORS = '__ROOSTERJS_DEVTOOLS_EDITORS__';
    var FROM_AGENT = 'roosterjs-devtools-agent';
    var TO_AGENT = 'roosterjs-devtools-panel';
    var REFRESH_EVENTS = { contentChanged: 1, input: 1, selectionChanged: 1, editorReady: 1 };

    var editors = []; // { editor, id, label, events }
    var nextEditorId = 1;
    var currentEditorId = null;
    var nodeMap = new Map(); // nodeId -> DOM element for the last serialized editor
    var reverseMap = new Map(); // DOM element -> nodeId for the last serialized editor
    var highlightDiv = null;
    var refreshTimer = null;
    var inspecting = false;
    var MAX_EVENTS = 100;

    // ---- messaging ---------------------------------------------------------
    function post(payload) {
        window.postMessage({ __rjsdt: FROM_AGENT, payload: payload }, '*');
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.source === window && data && data.__rjsdt === TO_AGENT) {
            handleCommand(data.payload);
        }
    });

    function handleCommand(cmd) {
        switch (cmd && cmd.type) {
            case 'init':
                sendEditors();
                sendModel();
                sendEvents();
                sendSelection();
                sendFormatState();
                sendHtml();
                break;
            case 'selectEditor':
                currentEditorId = cmd.editorId;
                sendModel();
                sendEvents();
                sendSelection();
                sendFormatState();
                sendHtml();
                break;
            case 'refresh':
                sendModel();
                sendSelection();
                sendFormatState();
                sendHtml();
                break;
            case 'setDarkMode':
                var darkModeEditor = getCurrentEditor();
                if (darkModeEditor) {
                    darkModeEditor.setDarkModeState(!!cmd.value);
                    sendFormatState();
                }
                break;
            case 'moveSnapshot':
                moveSnapshot(cmd.step);
                break;
            case 'getRawJson':
                sendRawJson();
                break;
            case 'focusEditor':
                var focusEditor = getCurrentEditor();
                if (focusEditor) {
                    focusEditor.focus();
                    sendFormatState();
                }
                break;
            case 'takeSnapshot':
                var snapshotTakingEditor = getCurrentEditor();
                if (snapshotTakingEditor) {
                    snapshotTakingEditor.takeSnapshot();
                    sendFormatState();
                    sendSnapshots();
                }
                break;
            case 'getSnapshots':
                sendSnapshots();
                break;
            case 'applySnapshot':
                applySnapshotAt(cmd.index);
                break;
            case 'applyHtml':
                applyHtml(cmd.html, cmd.selection, cmd.isDarkMode, cmd.logicalRootPath);
                break;
            case 'clearEvents':
                var clearedEntry = getCurrentEntry();
                if (clearedEntry) {
                    clearedEntry.events = [];
                }
                sendEvents();
                break;
            case 'highlight':
                highlight(cmd.nodeId);
                break;
            case 'clearHighlight':
                clearHighlight();
                break;
            case 'startInspect':
                startInspect();
                break;
            case 'stopInspect':
                stopInspect();
                break;
            case 'selectInEditor':
                selectInEditor(cmd.nodeId);
                break;
            case 'editFormat':
                editFormat(cmd.nodeId, cmd.key, cmd.value, cmd.valueType);
                break;
        }
    }

    function sendEditors() {
        post({
            type: 'editors',
            currentEditorId: currentEditorId,
            editors: editors.map(function (e) {
                return { id: e.id, label: e.label };
            }),
        });
    }

    function sendModel() {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'model', editorId: null, tree: null });
            return;
        }
        try {
            post({ type: 'model', editorId: currentEditorId, tree: serialize(editor) });
        } catch (e) {
            post({ type: 'model', editorId: currentEditorId, tree: null, error: String(e) });
        }
    }

    function sendEvents() {
        var entry = getCurrentEntry();
        post({ type: 'events', editorId: currentEditorId, entries: entry ? entry.events : [] });
    }

    function sendSelection(selection) {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'selection', editorId: null, selection: null });
            return;
        }
        try {
            var sel = selection !== undefined ? selection : editor.getDOMSelection();
            post({ type: 'selection', editorId: currentEditorId, selection: serializeSelection(sel) });
        } catch (e) {
            post({ type: 'selection', editorId: currentEditorId, selection: null });
        }
    }

    function sendFormatState() {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'formatState', editorId: null, state: null });
            return;
        }
        try {
            post({ type: 'formatState', editorId: currentEditorId, state: computeFormatState(editor) });
        } catch (e) {
            post({ type: 'formatState', editorId: currentEditorId, state: null, error: String(e) });
        }
    }

    function sendHtml() {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'html', editorId: null, html: null });
            return;
        }
        try {
            // getClonedRoot() is a deep clone, so reading it back out is a safe read-only op that
            // never touches the live editor DOM.
            post({
                type: 'html',
                editorId: currentEditorId,
                html: editor.getDOMHelper().getClonedRoot().innerHTML,
            });
        } catch (e) {
            post({ type: 'html', editorId: currentEditorId, html: null, error: String(e) });
        }
    }

    // Same sequence as the library's own undo()/redo() commands (roosterjs-content-model-core's
    // command/undo, command/redo) - only public IEditor calls, so no reimplementation risk here.
    function moveSnapshot(step) {
        var editor = getCurrentEditor();
        if (!editor) {
            return;
        }
        editor.focus();

        var manager = editor.getSnapshotsManager();
        if (step < 0 && manager.hasNewContent) {
            editor.takeSnapshot();
        }

        var snapshot = manager.move(step);
        if (snapshot) {
            editor.restoreSnapshot(snapshot);
        }

        sendModel();
        sendFormatState();
        sendHtml();
        sendSnapshots();
    }

    // ---- snapshots tab ---------------------------------------------------------
    // SnapshotsManager.move() only moves its internal index and returns the snapshot there - it
    // never touches editor content (only editor.restoreSnapshot() does that). So we can walk the
    // whole stack - back to the start, forward to the end - collecting every snapshot along the
    // way, then walk back to where we started, all without ever restoring anything. This is how we
    // get the full list a plain SnapshotsManager reference doesn't otherwise expose. The only
    // observable side effect on the host page is its own snapshot-changed listeners (if any) firing
    // a few extra times during the walk; nothing here ever calls restoreSnapshot.

    // Returns the manager's current index (-1 if there are no snapshots yet), leaving it unchanged.
    function getCurrentSnapshotIndex(manager) {
        if (!manager.canMove(0)) {
            return -1;
        }
        var steps = 0;
        while (manager.canMove(-1)) {
            manager.move(-1);
            steps++;
        }
        if (steps > 0) {
            manager.move(steps);
        }
        return steps;
    }

    // A generous safety cap, not a display truncation: html/selection/logicalRootPath are sent in
    // full (unlike the 2000-char preview cap the Events/Selection tabs use) because the panel needs
    // the exact content to reproduce "copy snapshot with metadata" - a truncated copy would be a
    // silently-corrupt one. This only guards against pathological cases; MAX_SIZE_LIMIT in
    // SnapshotsManagerImpl already caps the whole stack at 10MB, far more than any single snapshot
    // should reach in practice.
    var MAX_SNAPSHOT_HTML = 100000;

    function summarizeSnapshot(snapshot) {
        if (!snapshot) {
            return null;
        }
        var html = snapshot.html || '';
        var truncated = html.length > MAX_SNAPSHOT_HTML;
        return {
            html: truncated ? html.slice(0, MAX_SNAPSHOT_HTML) : html,
            htmlLength: html.length,
            truncated: truncated,
            isDarkMode: !!snapshot.isDarkMode,
            // Plain JSON-safe data already (path arrays / id strings, no DOM refs) - forwarded as-is
            // so the panel can build the same `html + <!--{...}-->` copy format the demo's
            // SnapshotPane uses, and round-trip it back through 'applyHtml' on paste.
            selection: snapshot.selection || null,
            logicalRootPath:
                snapshot.logicalRootPath && snapshot.logicalRootPath.length
                    ? snapshot.logicalRootPath
                    : null,
            hasEntityStates: !!(snapshot.entityStates && snapshot.entityStates.length),
            hasAdditionalState: !!(
                snapshot.additionalState && Object.keys(snapshot.additionalState).length
            ),
            hasLogicalRoot: !!(snapshot.logicalRootPath && snapshot.logicalRootPath.length),
        };
    }

    // Walks the whole stack (see note above) and always leaves the manager back at its original
    // index.
    function enumerateSnapshots(editor) {
        var manager = editor.getSnapshotsManager();
        var startIndex = getCurrentSnapshotIndex(manager);
        if (startIndex < 0) {
            return { currentIndex: -1, snapshots: [] };
        }

        var steps = 0;
        while (manager.canMove(-1)) {
            manager.move(-1);
            steps++;
        }

        var list = [summarizeSnapshot(manager.move(0))];
        while (manager.canMove(1)) {
            list.push(summarizeSnapshot(manager.move(1)));
        }

        var delta = steps - (list.length - 1);
        if (delta !== 0) {
            manager.move(delta);
        }

        return { currentIndex: steps, snapshots: list };
    }

    function sendSnapshots() {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'snapshots', editorId: null, currentIndex: -1, snapshots: [] });
            return;
        }
        try {
            var result = enumerateSnapshots(editor);
            post({
                type: 'snapshots',
                editorId: currentEditorId,
                currentIndex: result.currentIndex,
                snapshots: result.snapshots,
            });
        } catch (e) {
            post({
                type: 'snapshots',
                editorId: currentEditorId,
                currentIndex: -1,
                snapshots: [],
                error: String(e),
            });
        }
    }

    // Moves the manager's cursor to the given absolute index (found the same way
    // getCurrentSnapshotIndex does) and restores it - the same focus()+restoreSnapshot() pair the
    // demo's SnapshotPlugin.onMove uses, just driven by an absolute index instead of a relative step
    // since the panel only knows positions from the last enumerateSnapshots() result.
    function applySnapshotAt(targetIndex) {
        var editor = getCurrentEditor();
        if (!editor) {
            return;
        }
        var manager = editor.getSnapshotsManager();
        var currentIndex = getCurrentSnapshotIndex(manager);
        if (currentIndex < 0) {
            return;
        }
        var delta = targetIndex - currentIndex;
        if (delta !== 0 && !manager.canMove(delta)) {
            return;
        }
        var snapshot = manager.move(delta);
        if (snapshot) {
            editor.focus();
            editor.restoreSnapshot(snapshot);
        }

        sendModel();
        sendFormatState();
        sendHtml();
        sendSnapshots();
    }

    // Directly applies pasted/typed HTML (optionally with selection/isDarkMode/logicalRootPath
    // metadata parsed by the panel from a trailing `<!--{...}-->` comment, same format as the
    // demo's SnapshotPane "Copy snapshot with metadata") as the editor's new content - the same
    // focus()+restoreSnapshot() the demo's "Restore snapshot" button uses, but for a snapshot we
    // construct here rather than one taken from the stack. Deliberately does not touch the
    // snapshot stack itself (no addSnapshot/move) - it's a live content replacement, not a new undo
    // checkpoint; hit Take Snapshot afterward if you want it to become one.
    function applyHtml(html, selection, isDarkMode, logicalRootPath) {
        var editor = getCurrentEditor();
        if (!editor || typeof html !== 'string') {
            return;
        }
        var snapshot = {
            html: html,
            isDarkMode: typeof isDarkMode === 'boolean' ? isDarkMode : editor.isDarkMode(),
        };
        if (selection) {
            snapshot.selection = selection;
        }
        if (logicalRootPath && logicalRootPath.length) {
            snapshot.logicalRootPath = logicalRootPath;
        }

        editor.focus();
        editor.restoreSnapshot(snapshot);

        sendModel();
        sendFormatState();
        sendHtml();
        sendSnapshots();
    }

    function scheduleRefresh() {
        if (refreshTimer) {
            return;
        }
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            sendModel();
            sendFormatState();
            sendHtml();
        }, 100);
    }

    // ---- editor registry ---------------------------------------------------
    function addEditor(editor) {
        if (
            editors.some(function (e) {
                return e.editor === editor;
            })
        ) {
            return;
        }
        var label;
        try {
            label = editor.getDOMHelper().getDomAttribute('id') || '';
        } catch (e) {
            label = '';
        }
        var id = nextEditorId++;
        editors.push({ editor: editor, id: id, label: label || '(editor ' + id + ')', events: [] });
        if (currentEditorId == null) {
            currentEditorId = id;
        }
        sendEditors();
        sendModel();
        sendEvents();
        sendSelection();
        sendFormatState();
        sendHtml();
    }

    function removeEditor(editor) {
        editors = editors.filter(function (e) {
            return e.editor !== editor;
        });
        if (
            !editors.some(function (e) {
                return e.id === currentEditorId;
            })
        ) {
            currentEditorId = editors.length ? editors[0].id : null;
        }
        sendEditors();
        sendModel();
        sendEvents();
        sendSelection();
        sendFormatState();
        sendHtml();
    }

    function getCurrentEntry() {
        return (
            editors.filter(function (e) {
                return e.id === currentEditorId;
            })[0] || null
        );
    }

    function getEntry(editor) {
        return (
            editors.filter(function (e) {
                return e.editor === editor;
            })[0] || null
        );
    }

    function getCurrentEditor() {
        var entry = getCurrentEntry();
        return entry ? entry.editor : null;
    }

    function onPluginEvent(editor, event) {
        var entry = getEntry(editor);
        if (entry) {
            entry.events.push(summarizeEvent(event));
            if (entry.events.length > MAX_EVENTS) {
                entry.events.shift();
            }
            if (editor === getCurrentEditor()) {
                sendEvents();
            }
        }

        if (editor !== getCurrentEditor()) {
            return;
        }

        if (event.eventType === 'selectionChanged') {
            sendSelection(event.newSelection);
            sendFormatState();
        }

        if (REFRESH_EVENTS[event.eventType]) {
            scheduleRefresh();
        }
    }

    // ---- content model serialization --------------------------------------
    function elementOf(node) {
        return node.cachedElement || node.element || node.wrapper || null;
    }

    function describe(node) {
        if (node.__pseudo) {
            return { title: node.title };
        }
        if (node.blockGroupType) {
            var gt = node.blockGroupType;
            if (gt === 'FormatContainer') {
                gt += ' <' + node.tagName + '>';
            } else if (gt === 'General' && node.element) {
                gt += ' <' + node.element.tagName.toLowerCase() + '>';
            }
            return { title: gt };
        }
        if (node.segmentType) {
            var sub;
            var title = node.segmentType;
            if (node.segmentType === 'Text') {
                sub = JSON.stringify(node.text);
            } else if (node.segmentType === 'Image') {
                sub = node.src ? node.src.slice(0, 60) : '';
            } else if (node.segmentType === 'General' && node.element) {
                title += ' <' + node.element.tagName.toLowerCase() + '>';
            }
            return { title: title, subtitle: sub };
        }
        if (node.blockType) {
            var bt = node.blockType;
            if (node.blockType === 'Paragraph') {
                bt = node.isImplicit ? 'Paragraph (implicit)' : 'Paragraph';
            } else if (node.blockType === 'Divider') {
                bt = 'Divider <' + node.tagName + '>';
            } else if (node.blockType === 'Entity') {
                bt = 'Entity (block)';
            }
            return { title: bt };
        }
        return { title: 'Unknown' };
    }

    function childrenOf(node) {
        if (node.__pseudo) {
            return node.children;
        }
        if (node.blocks) {
            return node.blocks;
        }
        if (node.blockType === 'Paragraph') {
            return node.segments || [];
        }
        if (node.blockType === 'Table') {
            return (node.rows || []).map(function (row, i) {
                return { __pseudo: true, title: 'Row ' + i, children: row.cells || [] };
            });
        }
        return [];
    }

    function buildTree(node, ctx) {
        var id = ctx.nextId++;
        var info = describe(node);
        var element = node.__pseudo ? null : elementOf(node);
        if (element) {
            ctx.map.set(id, element);
            ctx.reverse.set(element, id);
        }
        var children = childrenOf(node).map(function (c) {
            return buildTree(c, ctx);
        });
        var selfSelected = !!(node.isSelected || node.isSelectedAsImageSelection);
        var hasSelection =
            selfSelected ||
            children.some(function (c) {
                return c.isSelected || c.hasSelection;
            });
        return {
            id: id,
            title: info.title,
            subtitle: info.subtitle,
            format: node.__pseudo ? null : node.format || null,
            isSelected: selfSelected,
            hasSelection: hasSelection,
            children: children,
        };
    }

    function serialize(editor) {
        var result = null;
        var ctx = { nextId: 1, map: new Map(), reverse: new Map() };
        editor.formatContentModel(
            function (model) {
                result = buildTree(model, ctx);
                return false; // read-only: never write back
            },
            undefined,
            { tryGetFromCache: true }
        );
        nodeMap = ctx.map;
        reverseMap = ctx.reverse;
        return result;
    }

    // Deep-clone the model keeping its real Content Model shape/field names (unlike buildTree(),
    // which renames things for tree display) so the exported JSON matches what someone would see
    // reading the model in code or in the demo's Content Model pane - useful for filing repros.
    // DOM element references (cachedElement/element/wrapper/table/image/etc.) can't survive
    // JSON.stringify meaningfully, so they're replaced with a short tag-name placeholder.
    function toJsonSafe(value, seen) {
        if (value === null || typeof value !== 'object') {
            return value;
        }
        if (value instanceof Node) {
            return '[DOM ' + (value.nodeName || value.nodeType) + ']';
        }
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return value.map(function (item) {
                return toJsonSafe(item, seen);
            });
        }
        var result = {};
        Object.keys(value).forEach(function (key) {
            result[key] = toJsonSafe(value[key], seen);
        });
        return result;
    }

    function sendRawJson() {
        var editor = getCurrentEditor();
        if (!editor) {
            post({ type: 'rawJson', editorId: null, json: null });
            return;
        }
        try {
            var json = null;
            editor.formatContentModel(
                function (model) {
                    json = JSON.stringify(toJsonSafe(model, new Set()), null, 2);
                    return false; // read-only: never write back
                },
                undefined,
                { tryGetFromCache: true }
            );
            post({ type: 'rawJson', editorId: currentEditorId, json: json });
        } catch (e) {
            post({ type: 'rawJson', editorId: currentEditorId, json: null, error: String(e) });
        }
    }

    // ---- event log -----------------------------------------------------------
    function truncate(str, len) {
        return typeof str === 'string' && str.length > len ? str.slice(0, len) + '…' : str;
    }

    // Convert a PluginEvent into a JSON-safe summary for the Events tab. Never forwards raw DOM
    // nodes, Files, or other live references (rawEvent, clipboardData.image, entity wrapper, etc.)
    // across the postMessage boundary - only derived strings/booleans/numbers.
    function summarizeEvent(event) {
        var detail;
        switch (event.eventType) {
            case 'keyDown':
            case 'keyPress':
            case 'keyUp':
                detail = { key: event.rawEvent.key, code: event.rawEvent.code };
                break;
            case 'input':
                detail = { inputType: event.rawEvent.inputType };
                break;
            case 'mouseDown':
            case 'mouseUp':
            case 'contextMenu':
            case 'doubleClick':
                detail = {
                    button: event.rawEvent.button,
                    target: event.rawEvent.target && event.rawEvent.target.tagName,
                    pageX: event.rawEvent.pageX,
                    pageY: event.rawEvent.pageY,
                };
                break;
            case 'pointerDown':
            case 'pointerUp':
                detail = { pointerType: event.rawEvent.pointerType };
                break;
            case 'contentChanged':
                detail = {
                    source: event.source,
                    data:
                        event.data && event.data.toString
                            ? truncate(event.data.toString(), 200)
                            : undefined,
                };
                break;
            case 'beforePaste':
                var cd = event.clipboardData;
                detail = {
                    types: cd.types,
                    text: truncate(cd.text, 200),
                    html: truncate(cd.html, 200),
                    hasImage: !!cd.image,
                    fromNativeEvent: !!cd.pasteNativeEvent,
                };
                break;
            case 'beforeCutCopy':
                detail = { isCut: event.isCut };
                break;
            case 'entityOperation':
                detail = {
                    operation: event.operation,
                    entityType: event.entity && event.entity.type,
                    entityId: event.entity && event.entity.id,
                };
                break;
            case 'editImage':
                detail = { newSrc: truncate(event.newSrc, 100) };
                break;
            case 'zoomChanged':
                detail = { newZoomScale: event.newZoomScale };
                break;
            case 'beforeKeyboardEditing':
                detail = { which: event.rawEvent.which };
                break;
            case 'selectionChanged':
                detail = { selectionType: event.newSelection ? event.newSelection.type : null };
                break;
            default:
                detail = undefined;
        }
        return { eventType: event.eventType, time: Date.now(), detail: detail };
    }

    // ---- selection -----------------------------------------------------------
    function describePoint(node, offset) {
        if (!node) {
            return null;
        }
        var kind =
            node.nodeType === 3 ? 'text' : node.nodeType === 1 ? node.tagName.toLowerCase() : '#' + node.nodeType;
        return {
            node: kind,
            offset: offset,
            preview: node.nodeType === 3 ? truncate(node.textContent || '', 40) : undefined,
        };
    }

    // Convert a DOMSelection into a JSON-safe summary for the Selection tab (no live Range/element
    // references cross the postMessage boundary).
    function serializeSelection(sel) {
        if (!sel) {
            return null;
        }
        if (sel.type === 'range') {
            var r = sel.range;
            return {
                type: 'range',
                isReverted: sel.isReverted,
                collapsed: r.collapsed,
                text: truncate(r.toString(), 200),
                start: describePoint(r.startContainer, r.startOffset),
                end: describePoint(r.endContainer, r.endOffset),
            };
        }
        if (sel.type === 'image') {
            return {
                type: 'image',
                tag: sel.image.tagName.toLowerCase(),
                src: truncate(sel.image.src || '', 100),
            };
        }
        if (sel.type === 'table') {
            return {
                type: 'table',
                firstRow: sel.firstRow,
                firstColumn: sel.firstColumn,
                lastRow: sel.lastRow,
                lastColumn: sel.lastColumn,
            };
        }
        return null;
    }

    // ---- format state ---------------------------------------------------------
    // Best-effort client-side port of roosterjs-content-model-dom's retrieveModelFormatState /
    // iterateSelections (not importable here - see devtools/PLAN.md). Same merge rule as the real
    // thing (first selected segment wins, later conflicting values are dropped), but skips a few
    // editing-focused edge cases the real function also handles: the DOMHelper container-format
    // fallback for segments that don't specify their own font/size/color, exact dark-mode color
    // reverse-mapping, and detailed table/image metadata (border/shadow/radius) - a debug panel
    // doesn't need those to answer "what's the format at my cursor".
    function isBoldWeight(weight) {
        return !!weight && (weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600);
    }

    function px2Pt(px) {
        if (typeof px === 'string' && px.slice(-2) === 'px') {
            return Math.round(parseFloat(px) * 75 + 0.05) / 100 + 'pt';
        }
        return px;
    }

    function retrieveFormatAtSelection(model, pendingFormat, state) {
        var isFirst = true;
        var firstParagraph = null;

        function mergeVal(key, value) {
            if (value === undefined) {
                return;
            }
            if (isFirst) {
                state[key] = value;
            } else if (state[key] !== value) {
                delete state[key];
            }
        }

        function visitParagraph(paragraph, ctx) {
            var selected = paragraph.segments.filter(function (s) {
                return ctx.treatAllSelected || s.isSelected;
            });
            if (selected.length === 0) {
                return;
            }

            if (firstParagraph && firstParagraph !== paragraph) {
                state.isMultilineSelection = true;
            }
            firstParagraph = firstParagraph || paragraph;

            var headingMatch = /^h([1-6])$/.exec(
                (paragraph.decorator && paragraph.decorator.tagName) || ''
            );
            mergeVal('headingLevel', headingMatch ? parseInt(headingMatch[1], 10) : undefined);
            mergeVal('textAlign', paragraph.format.textAlign);
            mergeVal('direction', paragraph.format.direction);
            mergeVal('isBullet', ctx.listType === 'UL');
            mergeVal('isNumbering', ctx.listType === 'OL');
            mergeVal('isBlockQuote', !!ctx.isBlockQuote);

            if (ctx.tableCell) {
                state.isInTable = true;
                state.tableHasHeader = !!ctx.tableHasHeader;
            }

            selected.forEach(function (segment) {
                var merged = Object.assign(
                    {},
                    paragraph.format,
                    paragraph.decorator && paragraph.decorator.format,
                    segment.format,
                    segment.code && segment.code.format,
                    segment.link && segment.link.format,
                    pendingFormat
                );
                var supSub = merged.superOrSubScriptSequence
                    ? merged.superOrSubScriptSequence.split(' ').pop()
                    : undefined;

                mergeVal('isBold', isBoldWeight(merged.fontWeight));
                mergeVal('isItalic', merged.italic);
                mergeVal('isUnderline', merged.underline);
                mergeVal('isStrikeThrough', merged.strikethrough);
                mergeVal('isSuperscript', supSub === 'super');
                mergeVal('isSubscript', supSub === 'sub');
                mergeVal('letterSpacing', merged.letterSpacing);
                mergeVal('fontName', merged.fontFamily);
                mergeVal('fontSize', px2Pt(merged.fontSize));
                mergeVal('backgroundColor', merged.backgroundColor);
                mergeVal('textColor', merged.textColor);
                mergeVal('lineHeight', merged.lineHeight);

                state.canUnlink = state.canUnlink || !!segment.link;
                if (segment.segmentType === 'Image') {
                    state.canAddImageAltText = true;
                }

                isFirst = false;
            });
        }

        function walk(group, ctx) {
            (group.blocks || []).forEach(function (block) {
                if (block.blockType === 'BlockGroup') {
                    var nextCtx = ctx;
                    if (block.blockGroupType === 'ListItem') {
                        var level = block.levels && block.levels[block.levels.length - 1];
                        nextCtx = Object.assign({}, ctx, { listType: level && level.listType });
                    } else if (block.blockGroupType === 'FormatContainer') {
                        nextCtx = Object.assign({}, ctx, {
                            isBlockQuote: block.tagName === 'blockquote',
                        });
                    }
                    walk(block, nextCtx);
                } else if (block.blockType === 'Paragraph') {
                    visitParagraph(block, ctx);
                } else if (block.blockType === 'Table') {
                    var tableHasHeader = (block.rows || []).some(function (row) {
                        return row.cells.some(function (c) {
                            return c && c.isHeader;
                        });
                    });
                    (block.rows || []).forEach(function (row) {
                        row.cells.forEach(function (cell) {
                            if (!cell) {
                                return;
                            }
                            walk(
                                cell,
                                Object.assign({}, ctx, {
                                    tableCell: true,
                                    tableHasHeader: tableHasHeader,
                                    treatAllSelected: ctx.treatAllSelected || cell.isSelected,
                                })
                            );
                        });
                    });
                }
            });
        }

        walk(model, {});
    }

    function computeFormatState(editor) {
        var manager = editor.getSnapshotsManager();
        var env = editor.getEnvironment();
        var state = {
            isDarkMode: editor.isDarkMode(),
            canUndo: manager.hasNewContent || manager.canMove(-1),
            canRedo: manager.canMove(1),
            hasFocus: editor.hasFocus(),
            isInShadowEdit: editor.isInShadowEdit(),
            isMac: env.isMac,
            isAndroid: env.isAndroid,
            isIOS: env.isIOS,
            isSafari: env.isSafari,
            isMobileOrTablet: env.isMobileOrTablet,
            isTouchSupported: env.isTouchSupported,
            experimentalFeatures: editor.getExperimentalFeatures(),
        };
        var pendingFormat = editor.getPendingFormat();

        editor.formatContentModel(
            function (model) {
                retrieveFormatAtSelection(model, pendingFormat, state);
                return false; // read-only: never write back
            },
            undefined,
            { tryGetFromCache: true }
        );

        return state;
    }

    // ---- highlight ---------------------------------------------------------
    function clearHighlight() {
        if (highlightDiv && highlightDiv.parentNode) {
            highlightDiv.parentNode.removeChild(highlightDiv);
        }
        highlightDiv = null;
    }

    function highlight(nodeId) {
        clearHighlight();
        var el = nodeMap.get(nodeId);
        if (!el || !el.ownerDocument) {
            return;
        }
        var rect = el.getBoundingClientRect();
        var div = el.ownerDocument.createElement('div');
        div.style.cssText =
            'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;' +
            'border:2px solid #8888ff;background:rgba(136,136,255,0.15);' +
            'left:' +
            rect.left +
            'px;top:' +
            rect.top +
            'px;width:' +
            rect.width +
            'px;height:' +
            rect.height +
            'px;';
        el.ownerDocument.body.appendChild(div);
        highlightDiv = div;
    }

    // ---- inspect (editor element -> tree node) -----------------------------
    function elementFromEventTarget(target) {
        return target ? (target.nodeType === 1 ? target : target.parentElement) : null;
    }

    function nodeIdForElement(el) {
        while (el) {
            if (reverseMap.has(el)) {
                return reverseMap.get(el);
            }
            el = el.parentElement;
        }
        return null;
    }

    function onInspectMove(e) {
        var id = nodeIdForElement(elementFromEventTarget(e.target));
        if (id != null) {
            highlight(id);
            post({ type: 'inspectHover', nodeId: id });
        } else {
            clearHighlight();
        }
    }

    function onInspectClick(e) {
        var id = nodeIdForElement(elementFromEventTarget(e.target));
        e.preventDefault();
        e.stopPropagation();
        stopInspect();
        if (id != null) {
            post({ type: 'inspectPick', nodeId: id });
        }
    }

    function onInspectKey(e) {
        if (e.key === 'Escape') {
            stopInspect();
        }
    }

    function startInspect() {
        var editor = getCurrentEditor();
        if (inspecting || !editor) {
            return;
        }
        // Refresh maps so the reverse lookup matches the current DOM.
        try {
            serialize(editor);
        } catch (e) {}
        var doc = editor.getDocument();
        doc.addEventListener('mousemove', onInspectMove, true);
        doc.addEventListener('click', onInspectClick, true);
        doc.addEventListener('keydown', onInspectKey, true);
        inspecting = true;
    }

    function stopInspect() {
        if (!inspecting) {
            return;
        }
        var editor = getCurrentEditor();
        var doc = editor ? editor.getDocument() : document;
        doc.removeEventListener('mousemove', onInspectMove, true);
        doc.removeEventListener('click', onInspectClick, true);
        doc.removeEventListener('keydown', onInspectKey, true);
        clearHighlight();
        inspecting = false;
        post({ type: 'inspectStopped' });
    }

    // ---- reverse select (tree node -> editor selection) --------------------
    function selectInEditor(nodeId) {
        var editor = getCurrentEditor();
        var el = nodeMap.get(nodeId);
        if (!editor || !el) {
            return;
        }
        try {
            if (el.scrollIntoView) {
                el.scrollIntoView({ block: 'nearest' });
            }
            var range = editor.getDocument().createRange();
            range.selectNodeContents(el);
            editor.setDOMSelection({ type: 'range', range: range, isReverted: false });
        } catch (e) {}
    }

    // ---- two-way editing (panel -> editor) ---------------------------------
    // Re-walk the model assigning ids in the same order as buildTree, and return the node whose id
    // matches. Lets us locate the node a panel edit refers to without holding the live model.
    function findNodeById(model, targetId) {
        var state = { nextId: 1, found: null };
        (function walk(node) {
            if (state.found) {
                return;
            }
            var id = state.nextId++;
            if (id === targetId) {
                state.found = node;
                return;
            }
            var kids = childrenOf(node);
            for (var i = 0; i < kids.length && !state.found; i++) {
                walk(kids[i]);
            }
        })(model);
        return state.found;
    }

    function coerce(value, valueType) {
        if (valueType === 'number') {
            var n = Number(value);
            return isNaN(n) ? value : n;
        }
        if (valueType === 'boolean') {
            return value === 'true' || value === '1';
        }
        return value;
    }

    function editFormat(nodeId, key, value, valueType) {
        var editor = getCurrentEditor();
        if (!editor) {
            return;
        }
        editor.formatContentModel(
            function (model) {
                var node = findNodeById(model, nodeId);
                if (!node || node.__pseudo || !node.format) {
                    return false; // nothing to write back
                }
                if (value === '') {
                    delete node.format[key];
                } else {
                    node.format[key] = coerce(value, valueType);
                }
                return true; // write back to DOM + add undo snapshot
            },
            { apiName: 'devToolsEditFormat' }
        );
    }

    // ---- install -----------------------------------------------------------
    window[HOOK] = {
        onEditorCreated: addEditor,
        onEditorDisposed: removeEditor,
        onPluginEvent: onPluginEvent,
    };

    // Discover editors created before the hook was installed (defensive; normally none at
    // document_start).
    (window[EDITORS] || []).forEach(addEditor);
})();
