// Service worker: routes messages between each DevTools panel and the content script of its tab.
//
//   panel  <--port-->  background  <--tabs.sendMessage / runtime.onMessage-->  content script
//
// The panel connects with a long-lived port and tells us which tabId it is inspecting. We keep a
// map of tabId -> panel port so messages coming back from the page can be delivered to the right
// panel.

const panelPorts = new Map();

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'panel') {
        return;
    }

    let tabId = null;

    port.onMessage.addListener(message => {
        if (message.type === 'connect') {
            tabId = message.tabId;
            panelPorts.set(tabId, port);
        } else if (tabId != null) {
            // Forward panel -> page (content script of the inspected tab)
            chrome.tabs.sendMessage(tabId, message).catch(() => {
                /* tab may not have a content script yet; ignore */
            });
        }
    });

    port.onDisconnect.addListener(() => {
        if (tabId != null) {
            panelPorts.delete(tabId);
        }
    });
});

// Forward page -> panel
chrome.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab && sender.tab.id;

    if (tabId != null) {
        const port = panelPorts.get(tabId);

        if (port) {
            port.postMessage(message);
        }
    }
});
