<div align="center">
  <img src="public/icon.svg" height="120" alt="RyanQuack Logo" />
  <h1>RyanQuack 🦆</h1>
  <p>
    <strong>"Ryanair says I need the app. Well fuck that. I'll get the ticket my way."</strong>
  </p>
  <p>
    A modern, open-source browser extension to fetch, display, and download Ryanair boarding passes on your desktop. No mobile app required.
  </p>
</div>

---

## 🧐 Why?

Ryanair often restricts mobile boarding passes to their native app, forcing users to install it or pay for printing. **RyanQuack** paddles upstream by fetching your booking details directly from their API and rendering the official Aztec barcode right in your browser.

It's lightweight, privacy-focused (data stays local), and works offline once fetched.

## ✨ Features

- **🎟️ Instant Boarding Passes:** Renders the official Aztec barcode usable at the gate.
- **🍏 Apple Wallet Export:** Downloads `.pkpass` files for your iPhone wallet.
- **🖼️ Image Export:** Generates a high-res PNG of your ticket for sharing or printing.
- **📋 Clipboard Support:** Copy the ticket image directly to your clipboard.
- **✈️ Flight Summaries:** View upcoming flights even before check-in opens.
- **🔒 Secure:** All data processing happens locally in your browser.

## 🚀 Installation

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

Don't have a flight booked? No problem. We included a powerful Mock Server to simulate various scenarios (Login, No Flights, Checked-In, etc.).

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

To build for real-world usage (hitting real Ryanair APIs):

```bash
# Build for both browsers
npm run build

# Or specific targets
npm run build:chrome
npm run build:firefox
```

### ✅ Testing

We use **Vitest** to ensure our logic is sound.

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
