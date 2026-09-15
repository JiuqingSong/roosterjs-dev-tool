// ISOLATED-world bridge. Relays between the MAIN-world agent (via window.postMessage) and the
// background service worker (via chrome.runtime). Both worlds share the same DOM window, so
// window.postMessage works across them.

const FROM_AGENT = 'roosterjs-devtools-agent'; // messages coming from the page agent
const TO_AGENT = 'roosterjs-devtools-panel'; // messages going to the page agent

// page agent -> background
window.addEventListener('message', event => {
    const data = event.data;

    if (event.source === window && data && data.__rjsdt === FROM_AGENT) {
        chrome.runtime.sendMessage(data.payload);
    }
});

// background -> page agent
chrome.runtime.onMessage.addListener(message => {
    window.postMessage({ __rjsdt: TO_AGENT, payload: message }, '*');
});
