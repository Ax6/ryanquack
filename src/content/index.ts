/**
 * RyanQuack - Ryanair Boarding Pass Helper
 * Copyright (C) 2026 Aaron Russo
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
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
