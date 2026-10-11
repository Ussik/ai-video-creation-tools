# Findings

- User selects eight videos in generation history. First click downloads one file; repeated clicks seem unresponsive.
- App.downloadAssets schedules an anchor click per asset, 120 ms apart, with target=_blank. It immediately reports all selected files started, without any request or file validation.
- Generated/uploaded file routes serve inline media; only exports force Content-Disposition. Asset URLs are local `/api/assets/:id/file` URLs.
- Browser automatic multiple-download limits are consistent with the user report. A single streaming ZIP response avoids that limit and does not buffer every video in the frontend.
- No applicable AGENTS.md or relevant memory entry found.
- Implemented POST preparation with validated project-owned, readable files and short-lived opaque descriptors. Browser streams a single native GET attachment; 100 bounded descriptors expire after ten minutes and are cleared when the app closes.
- Multiple files stream through yazl without recompressing media or buffering videos in the browser; safe Unicode names and case-insensitive duplicate suffixes preserve every asset. GET rechecks files to avoid silently omitting deleted files.
- Actual browser TaskSpace 17 is on the existing project. The user has continued generation and now has eleven video candidates; final verification should use the eight oldest videos shown in the original screenshot.
- Browser successfully downloaded `以命为薪-素材-8.zip` from the eight original selected videos; repeated download also succeeded. Both ZIPs contain all eight names and pass CRC checks. Independent SHA-256 comparison against read-only database file paths confirms every archived asset matches its original bytes (13,674,952 bytes total).
- Browser single-selection download retains the original MP4 filename and bytes. Download starts preserve the asset-library page; no popups or frontend media buffers are used.
