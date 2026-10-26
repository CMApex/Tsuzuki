<p align="center"><img src="extension/static/icons/256.png" width="96" alt=""></p>

<h1 align="center">続き Tsuzuki</h1>

<p align="center"><i>"Continue from where you left off."</i><br>
The useful half of watch history and search history, with none of it going to the platform.</p>

---

You turned off YouTube watch history and Google search history. Good. But now YouTube forgets where you stopped, your thumbnails have no progress bars, and the search you ran on your phone yesterday is gone.

Tsuzuki gives those features back **locally**:

- **Resume points.** Reopen a video and it jumps back to where you stopped (with a one-tap *Start over*).
- **Watched.** Videos you finish are remembered; thumbnails get a progress bar.
- **Search history.** Queries on Google, DuckDuckGo, Bing, Brave, Kagi and YouTube.
- **No algorithm.** Nothing is ranked or recommended. It's a ledger, not a feed.
- **Encrypted at rest**, with a passphrase only you know.
- **Optional sync** between your devices through a tiny relay *you* run, which only ever sees ciphertext.
- **Never records** in private windows.

Runs in **Firefox / Zen** (desktop) and **Safari** (macOS + iOS) from one codebase.

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
- **Keep it:** release builds of Firefox-based browsers only install signed add-ons. Signing for your own use is free and private: get API keys at <https://addons.mozilla.org/developers/addon/api/key/>, then

  ```sh
  npm run build:firefox
  npx web-ext sign --source-dir dist/firefox --channel unlisted \
      --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
  ```

  and install the `.xpi` it produces. Unlisted means it isn't published anywhere.
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
- Thumbnail progress bars are drawn in closed shadow DOM on *every* thumbnail, seen or not, so YouTube's scripts can't learn your local history by looking at which thumbnails got decorated.
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
extension/src/core/        model (CRDT), crypto, sync, URL parsing — pure, shared, tested
extension/src/background/  vault, lock/unlock, storage, sync scheduling, message API
extension/src/content/     youtube.js (resume, progress, thumbnails), search.js
extension/src/ui/          popup + options page
relay/                     Rust (axum) zero-knowledge blob store
test/                      node:test suites, incl. two devices syncing through a real relay
```

## Status

v0.1, built in one sitting. The core, crypto, relay and sync are covered by tests (including a property test of the CRDT laws and a two-device sync through a real relay process). The YouTube content script is tested against a simulated player, not live YouTube, and YouTube changes its markup often; selectors live at the top of `content/youtube.js`.

Not yet: changing the passphrase, pruning old tombstones, sites beyond YouTube and the search engines above.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`), for the extension and the relay alike.

In short: use it, study it, change it, share it. If you distribute a modified version, or run a modified relay that other people use over a network, you have to offer them your source under the same license. The relay's `GET /` points at its source for exactly that reason; if you run a fork, update `SOURCE_URL` in `relay/src/lib.rs`.
