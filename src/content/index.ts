import browser from "webextension-polyfill";

function extractTokens() {
    // TODO: Pull auth tokens from DOM, localStorage, or a page-bridge.
    return null;
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "RYQ_GET_TOKENS") {
      return;
    }

    const tokens = extractTokens();

    if (tokens) {
      return Promise.resolve({ tokens });
    }

    return browser.runtime.sendMessage({ type: "RYQ_GET_TOKENS" })
      .then((result) => ({ tokens: result }));
  });
