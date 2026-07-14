# Privacy Policy — Broken Link Checker

**Last updated:** 14 July 2026

Broken Link Checker (“the Extension”) is a Chrome extension that helps you find broken links on websites you choose to scan.

## What we collect

**We do not collect personal information.**  
There is no login, no analytics SDK, no advertising ID, and **no remote server operated by the developer** that receives scan results.

## Data stored on your device

The Extension stores data **only in your browser**, using Chrome’s `storage` API and IndexedDB:

- Scan history (domains, page URLs, link URLs, HTTP status results, timestamps)
- User settings (crawl limits, copy/export column preferences, resource-type toggles)

You can remove this data with **History → Delete all data**, or by removing the extension (which clears its storage).

## Network requests

When you start a scan, the Extension may:

1. Read links from the active page (via a content script).
2. Request page HTML or HTTP headers for links / crawl targets you initiated, in order to determine HTTP status codes (including following redirects).

Those requests go to **the websites being checked**, not to a developer backend. Clipboard use (for Sheets export) happens only when **you** trigger Copy / Open in Sheets.

## Permissions (why they exist)

| Permission | Reason |
|---|---|
| `storage` | Save settings and scan history locally |
| `sidePanel` | Show the results side panel |
| `activeTab` / `tabs` | Identify the page you are scanning and open the panel/options |
| `clipboardWrite` | Copy export tables when you click export/copy actions |
| Host access (`http`/`https`) | Check link status and crawl same-origin pages across sites you scan |

Content scripts run on `http`/`https` pages only, to highlight broken links and extract links when you scan.

## Sharing with third parties

We do **not** sell or share your data. Opening Google Sheets (`sheets.new`) is optional and only loads Google’s site in a new tab after you choose that action; we do not send scan data to Google except what you paste yourself from the clipboard.

## Children’s privacy

The Extension is not directed at children and does not knowingly collect children’s data.

## Changes

If this policy changes, we will update this file and the “Last updated” date in the package.

## Contact

For privacy questions about this Extension, contact the publisher listed on the Chrome Web Store listing once published.
