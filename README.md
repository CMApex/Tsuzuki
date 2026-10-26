<p align="center"><img src="extension/static/icons/256.png" width="96" alt=""></p>

<h1 align="center">続き Tsuzuki</h1>

<p align="center"><i>"Continue from where you left off."</i><br>
The useful half of watch history and search history, with none of it going to the platform.</p>

---

You turned off YouTube watch history and Google search history. Good. But now YouTube forgets where you stopped, your thumbnails have no progress bars, and the search you ran on your phone yesterday is gone.

Tsuzuki gives those features back **locally**:

- **Resume points.** Reopen a video and it jumps back to where you stopped (with a one-tap *Start over*).
- **Watched.** Videos you finish are remembered; thumbnails get a progress bar.
- **Search history**, with **"search again on…"** to re-run any remembered query on another engine.
- **Per-service opt-in.** Switch each site on or off; Tsuzuki only remembers what happens on the ones you choose.
- **A home page** with one search box for every engine (plus `!bangs` and instant matches from your own history), continue-watching across every service, and your recent searches.
- **Your own instances.** Add Invidious, Piped, PeerTube or SearXNG servers. Invidious and Piped share history with YouTube.
- **No algorithm.** Nothing is ranked or recommended. It's a ledger, not a feed.
- **Encrypted at rest**, with a passphrase only you know.
- **Optional sync** between your devices through a tiny relay *you* run, which only ever sees ciphertext.
- **Never records** in private windows.

Runs in **Firefox / Zen** (desktop) and **Safari** (macOS + iOS) from one codebase.

## Supported services

| | On by default | Opt-in |
|---|---|---|
| **Video** | YouTube, YouTube Music | Nebula, Twitch VODs, Vimeo (incl. embeds on other sites) |
| **Search** | Google, YouTube, DuckDuckGo (incl. HTML & Lite), Bing, Brave Search, Kagi | Startpage, Ecosia, Qwant, Mojeek, Yahoo, Yahoo! JAPAN, Yandex, Baidu, Naver |
| **Your instances** (Firefox / Zen) | | Invidious, Piped, PeerTube, SearXNG |

Toggle them under **Settings → Services**. YouTube Shorts and live streams aren't tracked. Everything about each site lives in [`extension/src/core/services.js`](extension/src/core/services.js) (URL formats) and [`extension/src/content/adapters.js`](extension/src/content/adapters.js) (player and title selectors), so adding one is a small, self-contained change.

The extension's content scripts are declared for every supported site, so your browser lists them all in Tsuzuki's permissions; on a switched-off site the script asks one question and exits without touching the page. Instances are different: each one is granted individually when you add it, and handed back when you remove it.

## Home page

Open it with **Alt+Shift+H** (change it under *about:addons → ⚙ → Manage Extension Shortcuts*), the **Home** button in the popup, or a bookmark. To make it your browser's homepage, open it once and paste its `moz-extension://…/ui/home.html` address into the homepage setting as a custom URL. (It doesn't take over the new-tab page; that's left to you.)

- **Search box:** Enter searches your default engine (click any engine chip while the box is empty to change it). Click a chip to search there instead, or use a bang anywhere in the query: `!g` `!yt` `!ddg` `!b` `!br` `!k` `!sp` `!eco` `!qw` `!mj` `!y` `!yj` `!ya` `!bd` `!nv`, and `!sx` `!inv` `!pi` `!pt` for your instances. As you type, matching videos and past searches from your own history appear; arrow keys + Enter open one. Matching is fuzzy: words in any order, typos (`kintusgi`), abbreviations (`kntsg`), and accents, full/half-width and katakana/hiragana don't matter. The popup's filter works the same way.
- **Continue watching** across YouTube, Nebula, Twitch, Vimeo and your instances, with time left and a per-service filter.
- **Thumbnails are off by default**, because loading them tells the video site which videos are on your page. Turn them on in the footer; if you've added an Invidious instance they load through it instead of from YouTube.

## How it works

```
  Zen / Firefox                       Safari on iPhone
 ┌────────────────────────┐          ┌────────────────────────┐
 │ content scripts        │          │ content scripts        │
 │  where you stopped,    │          │  m.youtube.com,        │
 │  finished, searches    │          │  search engines        │
 │           ▼            │          │           ▼            │
 │ background             │          │ background (worker)    │
 │  ledger (LWW-CRDT),    │          │  ledger (LWW-CRDT),    │
 │  sealed in storage     │          │  sealed in storage     │
 └───────────┬────────────┘          └───────────┬────────────┘
             │  AES-256-GCM, one blob per device │
             └─────────►┌─────────────┐◄─────────┘
                        │  tsuzuki-   │  can't read,
                        │  relay      │  can't forge
                        └─────────────┘
```

Each device keeps the whole ledger, encrypted with a key derived from your passphrase (PBKDF2-SHA256, 600k rounds → HKDF). To sync, a device uploads its encrypted snapshot to its own slot on the relay, pulls any other slots that changed, and merges. The ledger is a last-writer-wins CRDT, so merges never conflict and stale or replayed data can't undo newer changes. Details and the threat model are in [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requirements: Node 22+, Rust (for the relay), and a Mac with Xcode for the Safari build.

```sh
git clone https://github.com/CMApex/Tsuzuki
cd Tsuzuki
npm install
npm run build          # → dist/firefox and dist/safari
```

That's all you need to load the extension. To run the tests too (the sync tests talk to a real relay):

```sh
cd relay
cargo build
cd ..
npm test               # core, background, content-script, UI and two-device sync tests
```

On Windows, if PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `npm.cmd` in place of `npm`.

### Firefox / Zen

- **Try it:** open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick `dist/firefox/manifest.json`. (Temporary add-ons vanish on restart.)
- **Keep it:** Firefox-based release browsers (Zen included) only install signed add-ons permanently. Signing for your own use is free and private:
  1. Get API keys at <https://addons.mozilla.org/developers/addon/api/key/> (needs a free Firefox account).
  2. Put them in the environment and sign:

     ```powershell
     $env:WEB_EXT_API_KEY = "user:12345:67"      # "JWT issuer"
     $env:WEB_EXT_API_SECRET = "abc123…"         # "JWT secret"
     npm run sign:firefox
     ```

     (`export WEB_EXT_API_KEY=…` on macOS/Linux.) It uploads as *unlisted*, so it's signed but never published, and waits for the automatic review, usually a few minutes.
  3. Install `dist/artifacts/*.xpi`: drag it onto Zen, or *about:addons → ⚙ → Install Add-on From File*.

  Mozilla only signs each version number once, so bump `"version"` in `package.json` before signing an update.
  Switching from the temporary add-on to the signed one may start with empty storage, so *Export JSON* from Settings first, then *Import JSON* into the new vault.
- Firefox may ask you to allow the extension on YouTube and search sites. If nothing happens on YouTube, check *about:addons → Tsuzuki → Permissions*.

### Safari (Mac and iPhone)

On the Mac:

```sh
./scripts/make-safari.sh
open safari/Tsuzuki/Tsuzuki.xcodeproj
```

Set your signing team on each target and run the iOS scheme on your iPhone. A free Apple ID works, but the app expires after 7 days; a paid developer account (TestFlight) avoids that. Then on the phone: **Settings → Apps → Safari → Extensions → Tsuzuki**, turn it on and allow it on youtube.com and your search engine.

The extension only sees Safari. Videos watched in the YouTube *app* aren't recorded.

### The relay (optional, for sync)

```sh
cd relay
cargo run --release                       # listens on 127.0.0.1:8787
TSUZUKI_REGISTER_TOKEN=$(openssl rand -hex 16) TSUZUKI_BIND=0.0.0.0:8787 cargo run --release
```

or `docker build -t tsuzuki-relay relay && docker run -p 8787:8787 -v tsuzuki:/data tsuzuki-relay`.

Your phone needs to reach it over **HTTPS**. Two easy ways:

- **Tailscale:** run the relay on any machine in your tailnet and `tailscale serve --bg 8787`. Use the `https://<machine>.<tailnet>.ts.net` URL it prints. Nothing is exposed to the internet.
- **A VPS with Caddy:** `relay.example.net { reverse_proxy 127.0.0.1:8787 }` gives you automatic TLS. Set `TSUZUKI_REGISTER_TOKEN` so strangers can't create vaults on it.

`tsuzuki-relay --help` lists every setting.

### Setting up devices

1. On the first device, open the Tsuzuki popup → **New vault**. Choose a passphrase (four or five random words is ideal; there is **no recovery**). Add the relay URL if you have one.
2. Copy the **vault code** it shows (also under *Settings → Add another device*).
3. On each other device → **Join a vault** with the vault code, passphrase and the same relay URL.

## Privacy, honestly

- Turning off Google's history toggles controls what Google *shows you*, not what it *sees*. Google still serves every video and search, so it still knows about them. Tsuzuki doesn't change that; it only stops you from paying for privacy with convenience. Pair it with a privacy front-end if you want Google to see less.
- Resuming a video tells YouTube you started at 12:34, the same as opening a `&t=754s` link.
- Thumbnail progress bars are drawn in closed shadow DOM on *every* thumbnail, seen or not, so a site's own scripts can't learn your local history by looking at which thumbnails got decorated.
- Each site's script can only read and write its own part of the ledger: the background checks that the page sending an event really belongs to that service, and that the video key is in that service's namespace.
- The relay learns: your vault id, device ids, blob sizes and when you sync, and your IP. It can't read or forge anything.
- **Exports are plain JSON.** Handle them like the history they are.

## Development

```sh
npm run watch                    # rebuild on change
npm run run:firefox              # launch a throwaway Firefox profile with the extension
npm test                         # node tests (core, background, content script, UI, e2e sync)
npm run lint                     # web-ext lint
(cd relay && cargo test && cargo clippy --all-targets)
```

Layout:

```
extension/src/core/        model (CRDT), crypto, sync, services registry, URL parsing — pure, shared, tested
extension/src/background/  vault, lock/unlock, storage, sync scheduling, message API
extension/src/content/     tracker.js (resume, progress, thumbnails) + adapters.js per site;
                           video.js / search.js / instance.js entry points
extension/src/ui/          popup + options page (app.js), home page (home.js), shared helpers (lib.js)
relay/                     Rust (axum) zero-knowledge blob store
test/                      node:test suites, incl. two devices syncing through a real relay
```

## Status

v0.3. The core, crypto, relay and sync are covered by tests (including a property test of the CRDT laws and a two-device sync through a real relay process). The content scripts are tested against simulated pages and players for every kind of site, not against the live sites, which change their markup often; if one breaks, its selectors are in `content/adapters.js`.

Not yet: changing the passphrase, pruning old tombstones, custom instances in Safari (it can't register content scripts for new sites at runtime).

## Using Tsuzuki's core in another project

The data model, crypto, sync client and service registry are plain ES modules with no browser-extension dependencies, exported for reuse:

```js
// package.json: "dependencies": { "tsuzuki": "github:CMApex/Tsuzuki" }
import { emptyState, mergeInto } from 'tsuzuki/core/model';
import { deriveVaultSecrets, importEncKey } from 'tsuzuki/core/crypto';
import { RelayClient, syncOnce } from 'tsuzuki/core/sync';
import { searchTargets, linkForKey } from 'tsuzuki/core/services';
```

[docs/HANDOFF-frontpage.md](docs/HANDOFF-frontpage.md) explains how another app can join a vault as one more device.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`), for the extension and the relay alike.

In short: use it, study it, change it, share it. If you distribute a modified version, or run a modified relay that other people use over a network, you have to offer them your source under the same license. The relay's `GET /` points at its source for exactly that reason; if you run a fork, update `SOURCE_URL` in `relay/src/lib.rs`.
