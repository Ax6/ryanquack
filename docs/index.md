---
title: RyanQuack Privacy Policy
layout: default
---

# RyanQuack Privacy Policy

_Last updated: 30 May 2026_

This policy describes how the RyanQuack browser extension ("the extension") handles user data.

## Data collection

The extension does not collect, transmit, or store any user data on servers operated by the developer. No personal information, authentication credentials, or usage data is sent to the developer or to any third party.

## Data accessed locally

While in use, the extension accesses the following data **only within the user's browser** and **only on `ryanair.com`**:

- **Authentication information** — the user's existing Ryanair session cookie.
- **Personally identifiable information** — booking details returned by Ryanair (e.g. passenger name, flight number, seat, booking reference).

This data is accessed solely to display the user's own boarding passes and is not transmitted to any party other than Ryanair's own API endpoints (`*.ryanair.com`), which the user is already authenticated with.

## Use of data

User data is used **only** to provide the single, advertised feature of the extension: fetching and displaying the user's Ryanair boarding passes. It is not used for any other purpose, including but not limited to advertising, analytics, profiling, or creditworthiness assessment.

## Sharing with third parties

The extension does not sell, share, or transfer user data to any third party.

## Data retention and deletion

A short-lived copy of the user's most recent booking response is cached locally in the browser (`browser.storage.local`) to enable offline viewing. This cache:

- Remains on the user's device and is never transmitted elsewhere.
- Is overwritten on each successful fetch.
- Is fully deleted when the user uninstalls the extension.

The developer does not receive or store any user data, and therefore has no data to retain or delete on the user's behalf.

## Security

Because no user data leaves the user's device (other than to Ryanair's own servers over HTTPS), there is no developer-side data store that could be breached. The extension's full source code is publicly available for inspection at [github.com/Ax6/ryanquack](https://github.com/Ax6/ryanquack).

## Changes to this policy

Any changes to this policy will be published at this URL with an updated revision date.

## Contact

Questions about this policy can be raised at [github.com/Ax6/ryanquack/issues](https://github.com/Ax6/ryanquack/issues).
