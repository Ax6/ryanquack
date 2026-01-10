# ryanquack 🦆

> Ryanair says I need the app. Well fuck that. I'll get the ticket my way.

A modern browser extension to fetch, display, and download Ryanair boarding passes without needing the official mobile app.

## Features

- **Aztec Code Generation**: Displays the official boarding pass barcode directly in the popup.
- **Apple Wallet Support**: Download `.pkpass` files for your mobile wallet.
- **Cross-Browser**: Supports Chrome (Manifest V3) and Firefox (Manifest V3).
- **Offline Testing**: Includes a built-in mock server for development without active bookings.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Mock Testing

To test the extension without a real flight:

1. Start the mock server:
   ```bash
   npm run mock
   ```
2. Build the extension in mock mode:
   ```bash
   # For Chrome/Chromium
   npm run build:chrome:mock

   # For Firefox
   npm run build:firefox:mock
   ```
3. Load the unpacked extension from `dist/chrome-mock` or `dist/firefox-mock`.

## Building for Production

To build the extension for real usage:

```bash
# Build both
npm run build

# Build specific
npm run build:chrome
npm run build:firefox
```

The output will be in `dist/chrome` and `dist/firefox`.

## Testing

The project uses [Vitest](https://vitest.dev/) for unit testing core business logic and API handling.

```bash
npm test
```

## Architecture

- **Bundler**: [Vite](https://vitejs.dev/) + [@crxjs/vite-plugin](https://crxjs.ai/vite-plugin)
- **Language**: TypeScript
- **Polyfill**: [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for cross-browser Promise-based API support.
- **Barcode**: [bwip-js](https://github.com/metafloor/bwip-js) for Aztec code generation.