/*
 * RoosterJS DevTools - Phase 0 console agent
 *
 * Paste this whole file into the browser console of a page that hosts one or more RoosterJS
 * editors (built from a version that includes the devtools hook). It will:
 *   1. Install window.__ROOSTERJS_DEVTOOLS_HOOK__ so newly created editors register themselves.
 *   2. Discover editors that already exist (via window.__ROOSTERJS_DEVTOOLS_EDITORS__).
 *   3. Render a floating panel showing the Content Model of the selected editor as a <details> tree.
 *   4. Highlight the matching DOM element when you hover a node in the tree.
 *
 * This is a throwaway validation harness for Phase 0 - no framework, no build step.
 */
(function () {
    'use strict';

    var HOOK = '__ROOSTERJS_DEVTOOLS_HOOK__';
    var EDITORS = '__ROOSTERJS_DEVTOOLS_EDITORS__';
    var PANEL_ID = 'roosterjs-devtools-panel';

    // ---- state -------------------------------------------------------------
    var editors = []; // { editor, id, label }
    var nextEditorId = 1;
    var currentEditorId = null;
    var nodeMap = new Map(); // nodeId -> DOM element, rebuilt on every refresh
    var highlightDiv = null;
    var refreshing = false;

    // ---- editor registry ---------------------------------------------------
    function addEditor(editor) {
        if (editors.some(function (e) { return e.editor === editor; })) {
            return;
        }

        var label;
        try {
            label = editor.getDOMHelper().getDomAttribute('id') || '';
        } catch (e) {
            label = '';
        }

        var id = nextEditorId++;
        editors.push({ editor: editor, id: id, label: label || '(editor ' + id + ')' });

        if (currentEditorId == null) {
            currentEditorId = id;
        }

        renderEditorPicker();
        refresh();
    }

    function removeEditor(editor) {
        editors = editors.filter(function (e) { return e.editor !== editor; });

        if (!editors.some(function (e) { return e.id === currentEditorId; })) {
            currentEditorId = editors.length ? editors[0].id : null;
        }

        renderEditorPicker();
        refresh();
    }

    function getCurrentEditor() {
        var entry = editors.filter(function (e) { return e.id === currentEditorId; })[0];
        return entry ? entry.editor : null;
    }

    // ---- content model serialization --------------------------------------
    function elementOf(node) {
        return node.cachedElement || node.element || node.wrapper || null;
    }

    function describe(node) {
        if (node.__pseudo) {
            return { kind: node.kind, title: node.title };
        }

        if (node.blockGroupType) {
            var gt = node.blockGroupType;
            if (gt === 'FormatContainer') {
                gt += ' <' + node.tagName + '>';
            } else if (gt === 'General' && node.element) {
                gt += ' <' + node.element.tagName.toLowerCase() + '>';
            }
            return { kind: node.blockGroupType, title: gt };
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
            return { kind: node.segmentType, title: title, subtitle: sub };
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
            return { kind: node.blockType, title: bt };
        }

        return { kind: 'Unknown', title: 'Unknown' };
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
                return { __pseudo: true, kind: 'TableRow', title: 'Row ' + i, children: row.cells || [] };
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
        var ctx = { nextId: 1, map: new Map() };

        editor.formatContentModel(
            function (model) {
                result = buildTree(model, ctx);
                return false; // read-only: never write back
            },
            undefined,
            { tryGetFromCache: true }
        );

        nodeMap = ctx.map;
        return result;
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
            'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
            'width:' + rect.width + 'px;height:' + rect.height + 'px;';
        el.ownerDocument.body.appendChild(div);
        highlightDiv = div;
    }

    // ---- rendering ---------------------------------------------------------
    function renderNode(node) {
        var details = document.createElement('details');
        details.open = node.hasSelection || node.isSelected;

        var summary = document.createElement('summary');
        summary.dataset.nodeId = node.id;
        summary.className =
            'rd-summary' +
            (node.isSelected ? ' rd-selected' : node.hasSelection ? ' rd-child-selected' : '');

        var title = document.createElement('span');
        title.className = 'rd-title';
        title.textContent = node.title;
        summary.appendChild(title);

        if (node.subtitle) {
            var sub = document.createElement('span');
            sub.className = 'rd-subtitle';
            sub.textContent = node.subtitle;
            summary.appendChild(sub);
        }

        details.appendChild(summary);

        if (node.format && Object.keys(node.format).length) {
            var fmt = document.createElement('div');
            fmt.className = 'rd-format';
            fmt.textContent = JSON.stringify(node.format);
            details.appendChild(fmt);
        }

        node.children.forEach(function (child) {
            details.appendChild(renderNode(child));
        });

        return details;
    }

    function refresh() {
        var body = document.getElementById(PANEL_ID + '-body');
        if (!body) {
            return;
        }

        var editor = getCurrentEditor();
        body.innerHTML = '';

        if (!editor) {
            body.textContent = 'No editor selected.';
            return;
        }

        if (refreshing) {
            return;
        }

        refreshing = true;
        try {
            var tree = serialize(editor);
            body.appendChild(renderNode(tree));
        } catch (e) {
            body.textContent = 'Error: ' + (e && e.message);
            // eslint-disable-next-line no-console
            console.error('[roosterjs-devtools]', e);
        } finally {
            refreshing = false;
        }
    }

    function renderEditorPicker() {
        var select = document.getElementById(PANEL_ID + '-picker');
        if (!select) {
            return;
        }
        select.innerHTML = '';
        editors.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = String(e.id);
            opt.textContent = '#' + e.id + ' ' + e.label;
            opt.selected = e.id === currentEditorId;
            select.appendChild(opt);
        });
    }

    function buildPanel() {
        var existing = document.getElementById(PANEL_ID);
        if (existing) {
            existing.remove();
        }

        var style = document.createElement('style');
        style.textContent = [
            '#' + PANEL_ID + '{position:fixed;top:10px;right:10px;width:420px;max-height:80vh;',
            'display:flex;flex-direction:column;z-index:2147483647;background:#1e1e1e;color:#ddd;',
            'font:12px/1.4 Consolas,monospace;border:1px solid #444;border-radius:6px;',
            'box-shadow:0 4px 16px rgba(0,0,0,.5);}',
            '#' + PANEL_ID + ' .rd-head{display:flex;gap:6px;align-items:center;padding:6px 8px;',
            'background:#2d2d2d;border-bottom:1px solid #444;}',
            '#' + PANEL_ID + ' .rd-head b{flex:1;}',
            '#' + PANEL_ID + ' button,#' + PANEL_ID + ' select{background:#3a3a3a;color:#ddd;',
            'border:1px solid #555;border-radius:3px;padding:2px 6px;cursor:pointer;}',
            '#' + PANEL_ID + '-body{overflow:auto;padding:6px 8px;}',
            '#' + PANEL_ID + ' details{padding-left:12px;border-left:1px dotted #444;}',
            '#' + PANEL_ID + ' summary{cursor:pointer;white-space:nowrap;}',
            '#' + PANEL_ID + ' .rd-title{color:#9cdcfe;}',
            '#' + PANEL_ID + ' .rd-subtitle{color:#ce9178;margin-left:6px;}',
            '#' + PANEL_ID + ' .rd-selected>.rd-title{background:#553;border-radius:2px;}',
            '#' + PANEL_ID + ' .rd-child-selected>.rd-title{color:#dcdcaa;}',
            '#' + PANEL_ID + ' .rd-format{color:#808080;padding-left:14px;white-space:pre-wrap;',
            'word-break:break-all;}',
        ].join('');
        document.head.appendChild(style);

        var panel = document.createElement('div');
        panel.id = PANEL_ID;

        var head = document.createElement('div');
        head.className = 'rd-head';
        head.innerHTML = '<b>RoosterJS Content Model</b>';

        var picker = document.createElement('select');
        picker.id = PANEL_ID + '-picker';
        picker.title = 'Editor instance';
        picker.onchange = function () {
            currentEditorId = parseInt(picker.value, 10);
            refresh();
        };

        var refreshBtn = document.createElement('button');
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh';
        refreshBtn.onclick = refresh;

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        closeBtn.onclick = teardown;

        head.appendChild(picker);
        head.appendChild(refreshBtn);
        head.appendChild(closeBtn);

        var body = document.createElement('div');
        body.id = PANEL_ID + '-body';
        body.addEventListener('mouseover', function (ev) {
            var s = ev.target.closest && ev.target.closest('[data-node-id]');
            if (s) {
                highlight(parseInt(s.dataset.nodeId, 10));
            }
        });
        body.addEventListener('mouseout', clearHighlight);

        panel.appendChild(head);
        panel.appendChild(body);
        document.body.appendChild(panel);
    }

    // ---- change detection (Phase 0: DOM-based) -----------------------------
    function onMaybeChanged() {
        var editor = getCurrentEditor();
        // Only refresh for the focused editor to avoid cross-editor churn
        if (editor && (editors.length === 1 || editor.hasFocus())) {
            refresh();
        }
    }

    function teardown() {
        document.removeEventListener('selectionchange', onMaybeChanged);
        document.removeEventListener('input', onMaybeChanged, true);
        clearHighlight();
        var panel = document.getElementById(PANEL_ID);
        if (panel) {
            panel.remove();
        }
        if (window[HOOK] === hook) {
            delete window[HOOK];
        }
        delete window.__roosterjsDevtools;
        // eslint-disable-next-line no-console
        console.log('[roosterjs-devtools] detached');
    }

    // ---- install -----------------------------------------------------------
    var hook = {
        onEditorCreated: addEditor,
        onEditorDisposed: removeEditor,
    };
    window[HOOK] = hook;

    buildPanel();

    // Discover editors that were created before this script ran
    (window[EDITORS] || []).forEach(addEditor);

    document.addEventListener('selectionchange', onMaybeChanged);
    document.addEventListener('input', onMaybeChanged, true);

    window.__roosterjsDevtools = {
        refresh: refresh,
        editors: function () { return editors.slice(); },
        detach: teardown,
    };

    // eslint-disable-next-line no-console
    console.log(
        '[roosterjs-devtools] attached. Found ' +
            editors.length +
            ' editor(s). Use window.__roosterjsDevtools.detach() to remove.'
    );
})();
