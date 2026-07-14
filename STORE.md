# Chrome Web Store — publish checklist

## Privacy practices (Developer Dashboard)

When answering Chrome’s privacy questionnaire, use:

- **Single purpose:** Find and report broken links on pages the user chooses to scan.
- **User data:** Does not collect user data remotely. Local-only storage for scan history and settings.
- **Remote code:** No. All code ships in the package (MV3; no remote scripts).
- **Privacy policy URL:** Host `PRIVACY.md` on a public HTTPS URL (GitHub Pages/raw or your site) and paste that URL into the listing. Chrome requires a publicly accessible policy URL for most listings that use host permissions.

## Store listing justification for host permissions

> This extension checks whether links on a page return successful HTTP responses. It needs access to http/https URLs so it can request those links (and, for domain crawl, fetch same-origin pages) and report status codes. Data is not sent to the developer.

## Assets required by Chrome

- Icon 128×128 (included: `icons/icon128.png`)
- Small tile 440×280 (create separately for listing)
- Screenshots of popup / sidebar / options (create from a real scan)
- Privacy policy URL (see above)

## Pre-submit technical checks

- [x] Manifest V3
- [x] No `eval` / no remote code
- [x] Content scripts limited to `http://*/*` and `https://*/*` (not `file:` / `chrome:`)
- [x] Unused `scripting` permission removed
- [x] Welcome / privacy shown after install
- [x] User can wipe local data (Delete all data)
- [ ] Host privacy policy online and add URL to listing
- [ ] Screenshots + store description
- [ ] Test on a clean Chrome profile: Install → Welcome opens → Scan page → History → Delete data

## Zip for upload

Package the extension folder **without** unrelated files if any. Include `manifest.json`, `PRIVACY.md`, icons, and source. Do not include `.git` if packaging manually.
