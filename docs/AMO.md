# Submitting Tsuzuki to addons.mozilla.org

Everything needed for a **listed** submission: the files to upload, the listing text to paste, and notes for reviewers.

## 1. Build the upload files

```sh
git pull
npm ci
npm run package:amo
```

This writes two files to `dist/amo/`:

- `tsuzuki-<version>.zip` — the extension to upload.
- `tsuzuki-<version>-source.zip` — the source code to upload when AMO asks ("Do you need to submit source code?" → **Yes**). It's `git archive` of the exact commit, including `package-lock.json`.

Bump `"version"` in `package.json` first if this version number was already signed.

## 2. Upload

1. Go to the [Developer Hub](https://addons.mozilla.org/developers/) and sign in with your Mozilla account.
2. **First time:** choose **Submit a New Add-on** → **On this site**. This claims the ID `tsuzuki@cmapex`. **Later versions:** open Tsuzuki → **Upload New Version** → **On this site**. (If you ever signed it unlisted with `npm run sign:firefox`, the add-on already exists, so use Upload New Version.) The listing details are all in section 3.
3. Upload `tsuzuki-<version>.zip`. Validation should report no errors or warnings.
4. **Platforms:** Firefox only. Leave **Firefox for Android unticked** until it has been tested there.
5. **Source code:** Yes, then upload `tsuzuki-<version>-source.zip`.
6. Fill in the listing (section 3) and paste the reviewer notes (section 4).

## 3. Listing

**Name:** Tsuzuki

**Summary** (≤ 250 characters):

> Resume videos where you stopped, see what you've watched, and keep your search history: locally, encrypted, with no algorithm and nothing sent to anyone. Works with YouTube, Nebula, Twitch, Vimeo and 15 search engines.

**Description:**

> 続き (*tsuzuki*) means "continuation."
>
> Turned off YouTube watch history and Google search history? Good. Tsuzuki gives you back the useful half, without handing it to anyone:
>
> • **Resume where you stopped.** Reopen a video and it jumps back to where you left off, with a one-tap "Start over."
> • **Watched.** Videos you finish are remembered, and thumbnails get a small progress bar.
> • **Search history**, with "search again on…" to re-run any past query on another engine.
> • **A home page** with one search box for every engine (with !bangs), instant fuzzy matches from your own history, and everything you were in the middle of.
> • **Themes:** Sumi, Washi, Aero and Aero Night, plus your own custom CSS.
> • **Your instances:** add Invidious, Piped, PeerTube or SearXNG servers. Invidious and Piped share history with YouTube.
>
> **Supported:** YouTube, YouTube Music, Nebula, Twitch VODs, Vimeo; Google, YouTube, DuckDuckGo, Bing, Brave Search, Kagi, Startpage, Ecosia, Qwant, Mojeek, Yahoo, Yahoo! JAPAN, Yandex, Baidu, Naver. Each one can be switched on or off; the newer ones start off.
>
> **What Tsuzuki changes on websites:** it adds a "Tsuzuki · Resumed at…" notice when it resumes a video, and thin progress bars on video thumbnails. Both can be turned off in Settings.
>
> **What it sends: nothing, by default.** No analytics, no telemetry, no developer server. Your history is encrypted on your device with a passphrase only you know. Private windows are never recorded.
>
> **Optional sync:** run the tiny open-source relay yourself and your devices sync through it, end-to-end encrypted. Firefox asks for your permission first. The relay stores only ciphertext it can't read.
>
> No algorithm, no recommendations: it's a ledger, not a feed.
>
> Open source (AGPL-3.0): https://github.com/CMApex/Tsuzuki

**Categories:** Privacy & Security; Photos, Music & Videos

**Tags:** youtube, history, privacy, resume, search history

**Support website:** https://github.com/CMApex/Tsuzuki/issues

**License:** GNU Affero General Public License v3.0

**Privacy policy:** tick "This add-on has a privacy policy" and paste the contents of [`PRIVACY.md`](../PRIVACY.md).

**Screenshots:** `docs/screenshots/*.png` (1280×800, rendered from the real UI with invented sample data, so no real creators appear), suggested captions:

1. `01-home-sumi.png`: The home page: everything you were in the middle of, one search box for every engine.
2. `02-home-aero.png`: The Aero theme. There's also Sumi, Washi, Aero Night, and your own CSS.
3. `03-lists.png`: Continue, Watched and Searches, also in the toolbar popup.
4. `04-services.png`: Switch each service on or off, and add your own instances.
5. `05-search.png`: Fuzzy search across your own history.

**Release notes:** start with "First public release." and copy the highlights from the description.

## 4. Notes for reviewers (paste as-is)

> **What it does:** local-first watch history, resume points and search history. All data is stored on the device, encrypted with a key derived from the user's passphrase (WebCrypto PBKDF2 → HKDF → AES-GCM). No developer server, analytics or remote code.
>
> **Build (source code is bundled with esbuild, not minified):**
> Requirements: Node.js 22 or newer.
> ```
> npm ci
> npm run build:firefox
> ```
> Output: `dist/firefox/`, which matches the uploaded package. Dependencies come only from npm via `package-lock.json` (esbuild, plus jsdom for tests). Entry points: `extension/src/background/index.js`, `extension/src/content/{video,search,instance}.js`, `extension/src/ui/{app,home,boot}.js`. Tests: `npm test`.
>
> **Testing without an account:** install, open the popup, choose "New vault" and set any passphrase of 12+ characters (leave the relay empty). Watch a YouTube video for ~30 seconds, close it, reopen it: it resumes with a "Tsuzuki · Resumed at…" notice. Search on DuckDuckGo, then see Searches in the popup, or press Alt+Shift+H for the home page.
>
> **Permissions:**
> - `storage`, `unlimitedStorage`: the encrypted ledger.
> - `alarms`: periodic sync, only if the user configured a relay.
> - `scripting` + optional host permission `*://*/*`: only used when the user adds a self-hosted instance (Invidious/Piped/PeerTube/SearXNG) by URL. The add-on then requests that single origin with `permissions.request` from the click, and registers its content script for that origin only. Removing the instance unregisters the script and removes the permission.
> - Content-script host matches: the supported video sites and search engines' results pages. Each service is switched on or off by the user (the newer ones start off). On a switched-off service the script asks the background once and exits without touching the page. The background independently verifies every message's sender URL against the claimed service.
>
> **Data collection:** `required: ["none"]`, `optional: ["browsingActivity", "searchTerms"]`. Nothing leaves the browser unless the user enters the URL of a relay server *they run themselves*. At that point the add-on requests the optional data-collection permissions, and sync stays paused until they're granted. The relay receives only ciphertext. Search terms are read from the URL (or, for engines that POST, the search box) of results pages the user visits, and kept as local history. Tsuzuki never intercepts, redirects, alters or transmits searches to anyone else.
>
> **Page modifications:** a dismissible notice when a video is resumed (names the add-on), and progress bars on video thumbnails, both in closed shadow roots. Both are core features and can be turned off in Settings. No page security headers or CSP are modified.
>
> **Custom CSS:** users can add CSS to the extension's own pages. It is validated so it cannot load network resources (no @import or non-data `url()`), to stop pasted themes from leaking history.
>
> **Private windows:** `incognito: not_allowed`, and content scripts also check `inIncognitoContext`.
