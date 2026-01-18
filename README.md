<div align="center">
  <img src="public/icon.png" height="120" alt="RyanQuack Logo" />
  <h1>RyanQuack 🦆</h1>
  <p>
    <strong>"Ryanair says I need the app. Well quack that. I'll get the ticket my way."</strong>
  </p>
  <p>
    An open-source browser extension to fetch, display, and download Ryanair boarding passes on your browser. No mobile app required.
  </p>
</div>

---

## 🧐 Why?

Ryanair has decided that you can download boarding passes only from their mobile app, this way they can hug you with marketing and squeeze all that sweet tracking data from you. I don't need the app. So **RyanQuack** paddles upstream by fetching your booking details directly from their website and rendering flight tickets right in your browser.

It's lightweight, privacy-focused (your data stays local), and works offline once fetched.

## ✨ Features

- **🎟️ Instant Boarding Passes:** Renders a scannable QR code usable at the gate (tested personally).
- **🍏 Apple Wallet Export:** Downloads `.pkpass` files for your iPhone wallet.
- **🖼️ Image Export:** Generates a high-res PNG of your ticket for sharing or printing.
- **📋 Clipboard Support:** Copy the ticket image directly to your clipboard.
- **✈️ Flight Summaries:** View upcoming flights even before check-in opens.
- **🔒 Secure:** All data processing happens locally in your browser.

## 🚀 Installation

- [Chrome extension](https://chromewebstore.google.com/detail/ryanquack/ngbbihpkolpkbgnboinpcjinjihanjch?authuser=0&hl=en)
- [Firefox Add-On](https://addons.mozilla.org/en-GB/firefox/addon/ryanquack/)

### From Source (Developer Mode)

1.  **Clone the nest:**
    ```bash
    git clone https://github.com/yourusername/ryanquack.git
    cd ryanquack
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Hatch the build:**
    ```bash
    npm run build
    ```
4.  **Load into Browser:**
    *   **Chrome:** Go to `chrome://extensions`, enable **Developer Mode**, click **Load Unpacked**, and select `dist/chrome`.
    *   **Firefox:** Go to `about:debugging`, click **This Firefox**, then **Load Temporary Add-on**, and select `dist/firefox/manifest.json`.

---

## 🛠️ Development

This project uses **Vite**, **TypeScript**, and **Manifest V3** for both Chrome and Firefox.

### 🧪 Mock Server (The Playground)

Don't have a flight booked? No problem. Find included a test Server to simulate various scenarios (Login, No Flights, Checked-In, etc.).

1.  **Start the Mock Server:**
    ```bash
    npm run mock
    ```
    > 🦆 **Tip:** Open [http://localhost:3000](http://localhost:3000) to access the **Scenario Dashboard** and control the mock data dynamically!

2.  **Build & Watch (Mock Mode):**
    ```bash
    # For Chrome
    npm run build:chrome:mock

    # For Firefox
    npm run build:firefox:mock
    ```
    *These builds automatically point API requests to `localhost:3000`.*

### 🏗️ Production Build

To build the extension for real-world usage:

```bash
# Build for both browsers
npm run build

# Or specific targets
npm run build:chrome
npm run build:firefox
```

To package the extension:

```bash
npm run package
```

### ✅ Testing

Use **Vitest** to ensure logic is sound.

```bash
npm test
```

## 🏗️ Architecture

*   **Bundler:** [Vite](https://vitejs.dev/) + [@crxjs/vite-plugin](https://crxjs.ai/vite-plugin)
*   **Framework:** Vanilla TypeScript (No heavy UI frameworks).
*   **Barcode:** [bwip-js](https://github.com/metafloor/bwip-js) for Aztec rendering.
*   **Compatibility:** Uses `webextension-polyfill` to support both Chrome and Firefox using standard Promise-based APIs.

## ⚠️ Disclaimer

This project is for educational purposes only. It is not affiliated with, endorsed by, or connected to Ryanair. Use at your own risk. Always ensure you have a backup plan when traveling.

---

<div align="center">
  <sub>Made with 🧡 and 🦆 by Aaron Russo</sub>
</div>
