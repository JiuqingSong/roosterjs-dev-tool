// Registers the "Content Model" panel in Chrome DevTools.
chrome.devtools.panels.create(
    'Content Model',
    '',
    'panel.html',
    function () {
        /* panel created */
    }
);
