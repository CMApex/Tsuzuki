# Handoff: the Tsuzuki "frontpage" (Tier 2/3)

*For the Claude instance (or human) starting the frontpage project in a new repo. Written at the end of the chat that built Tsuzuki v0.1–v0.2, 2026-10-26.*

## 1. What exists today

**Tsuzuki** (`github.com/CMApex/Tsuzuki`, AGPL-3.0-or-later) is a browser extension for Firefox/Zen and Safari (macOS + iOS). It brings back watch history, resume points, "watched" markers and search history with nothing stored by the platforms: everything lives in a local, encrypted ledger that syncs between the user's devices through a zero-knowledge relay she runs herself.

| Piece | Where | Notes |
|---|---|---|
| Ledger model (CRDT) | `extension/src/core/model.js` | pure ES module |
| Crypto | `extension/src/core/crypto.js` | WebCrypto only; runs in browsers and Node |
| Sync client | `extension/src/core/sync.js` | talks to the relay |
| Service registry | `extension/src/core/services.js` | every supported site, URL → key, links, bangs |
| Relay | `relay/` (Rust, axum) | dumb encrypted-blob store, one slot per device |
| Background / content scripts / UI | `extension/src/{background,content,ui}` | extension-specific |
| Design + threat model | `docs/DESIGN.md` | read this next |

There is also a **Tier 1 home page** (`extension/src/ui/home.js`) inside the extension. It has a search box with engine chips and `!bangs`, live matches from the user's history, continue-watching across services, recent searches with "search again on…", and recently finished. It only *links out* to the real sites. The frontpage project is what goes beyond that.

### Supported services (v0.2)

- **Video:** YouTube, YouTube Music, Nebula, Twitch VODs, Vimeo.
- **Search:** Google, YouTube, DuckDuckGo, Bing, Brave, Kagi, Startpage, Ecosia, Qwant, Mojeek, Yahoo, Yahoo! JAPAN, Yandex, Baidu, Naver.
- **User-added instances:** Invidious, Piped, PeerTube, SearXNG.

## 2. The goal of the new project

The user (Nat) wants a **one-stop page** for all of this. It should be clean and cross-platform, effectively a better "YouTube web" on mobile. It would show results from many services in one UI, play things, and remember progress, without algorithms or platform-side history.

Feasibility was discussed and split into tiers:

- **Tier 2 (do this):** a unified search and results UI built on backends that *have real APIs*: SearXNG (JSON output), Invidious and/or Piped (JSON APIs for YouTube), PeerTube (public REST). Playback through the official privacy-enhanced YouTube embed, or streams via the user's Invidious. Nebula, Twitch and Vimeo link out at first, since their APIs need accounts or keys.
- **Tier 3 (be careful):** talking to YouTube directly (own player, InnerTube scraping, signature/n-param handling, PoTokens). It's possible but a permanent maintenance treadmill (see FreeTube, NewPipe, yt-dlp), and against YouTube's ToS. The agreed direction is to get Tier-3 *experience* by building Tier 2 on top of a **self-hosted Invidious**, and let that project fight YouTube.

Why a separate repo: it's a different product with a different risk profile. If a client project ever draws a ToS complaint, Tsuzuki shouldn't be tangled in it. It **reuses Tsuzuki's core** as a dependency rather than copying it.

## 3. Recommended architecture (proposal, not decided)

**A PWA served from Nat's own box, plus a tiny server-side helper, joining her Tsuzuki vault as one more device.**

```
 iPhone / desktop browser                         Nat's box (Tailscale / HTTPS)
┌──────────────────────────────┐                ┌─────────────────────────────────┐
│ Frontpage PWA                │  /api/* ─────▶ │ frontpage helper (Rust/axum?)   │──▶ Invidious / Piped API
│  - Tsuzuki core (ledger,     │                │  - CORS, aggregation, caching   │──▶ SearXNG ?format=json
│    crypto, sync)             │                │  - never sees keys or ledger    │──▶ PeerTube REST
│  - passphrase → key in page  │                └─────────────────────────────────┘
│  - ledger sealed in IndexedDB│  encrypted ─▶  tsuzuki-relay (already exists)
└──────────────────────────────┘
```

Why this shape:
- **It works on any browser**, including iOS Safari without the extension and without fighting Safari-extension limits. It can be added to the home screen.
- **It is just another Tsuzuki device.** The user enters vault code + passphrase, the PWA derives the key *client-side*, pulls blobs, merges and pushes its own slot. Progress made in the PWA shows up in the extension and vice versa. The relay still sees only ciphertext.
- **The helper exists for CORS and aggregation.** Many SearXNG instances don't send CORS headers, and JSON output must be enabled in `settings.yml` (`search: formats: [html, json]`). The helper only ever sees queries, never keys or ledger contents, and it is Nat's own server.
- **Alternative:** a second extension page inside Tsuzuki (host permissions sidestep CORS). Simpler on desktop, worse on iOS. Worth keeping in mind for a desktop-only v0.

**Playback and progress:** with the YouTube IFrame Player API (`youtube-nocookie.com/embed/<id>`), the page can read `getCurrentTime()` / `getDuration()` and call `recordProgress()`, so the frontpage *itself* records resume points with no content script involved. With Invidious streams in a native `<video>`, even simpler.

## 4. Using Tsuzuki's core

`package.json` exports the core modules:

```js
// "dependencies": { "tsuzuki": "github:CMApex/Tsuzuki" }   (pin a commit for reproducibility)
import { emptyState, mergeInto, recordProgress, recordSearch, forget, listLive, progressFor, stats } from 'tsuzuki/core/model';
import { KDF_ITERATIONS, deriveVaultSecrets, importEncKey, sealJSON, openJSON, aad, randomId } from 'tsuzuki/core/crypto';
import { RelayClient, syncOnce, normalizeRelayUrl } from 'tsuzuki/core/sync';
import { SERVICES, INSTANCE_TYPES, identifyVideo, linkForKey, labelForKey, labelForSrc, searchLinkFor, searchTargets, parseBang } from 'tsuzuki/core/services';
```

Verified: these import and run from a separate package (Node 22; they are browser-safe too).

### Ledger shape and invariants (don't break these)

Three maps of last-writer-wins registers:

| map | key | value |
|---|---|---|
| `resume` | `yt:<11-char id>`, `nebula:<slug>`, `twitch:<digits>`, `vimeo:<digits>`, `pt:<host>:<id>` | `{ at, dev, t, dur, title?, ch? }` |
| `watched` | same keys | `{ at, dev, title?, ch? }` |
| `searches` | random id | `{ at, dev, q, src }` where `src` is an engine `src` (`google`, `duckduckgo`, …) or `<instanceType>:<host>` |

- Any value can be a tombstone `{ at, dev, del: true }`.
- **Merge** = per key, the max under `(at, dev, canonical JSON)`. It's commutative, associative and idempotent (property-tested). Never "fix up" records outside these rules, or devices diverge.
- **Local writes** must use `nextAt(existing, now)` (the model functions already do), so a device with a lagging clock can still overwrite what it has seen.
- `dev` is the writing device's id. A new app = a new device id (`randomId(12)`, 16 URL-safe chars).
- Incoming data is sanitized (`sanitizeRecord`): titles ≤300 chars, queries ≤500, keys ≤128.
- Policy lives in the model: resume points under 15 s are ignored. "Finished" means 90% played or ≤25 s left, which writes `watched` and tombstones `resume`. Identical searches from the same engine within 10 minutes count as one.
- Invidious and Piped use **YouTube keys** (`yt:<id>`). That's deliberate: one shared history.

### Joining a vault from a new app (mirror `joinVault` in `extension/src/background/core.js`)

1. Inputs: vault code (16–64 chars, `[A-Za-z0-9_-]`), passphrase, relay URL (`normalizeRelayUrl`: https, or http only for localhost/.local).
2. `deriveVaultSecrets(passphrase, vaultId, KDF_ITERATIONS)` gives `{ encKeyRaw, authToken }`, then `importEncKey(encKeyRaw)`.
   - ⚠️ **The iteration count must be `KDF_ITERATIONS` (600 000).** It isn't stored anywhere in the vault, so a different count derives different keys. Storing KDF parameters in a relay-side vault header would be a worthwhile Tsuzuki improvement; coordinate before changing anything.
3. `new RelayClient({ baseUrl, vaultId, authToken })`, then `.list()`:
   - **401** means wrong passphrase.
   - **`[]`** means no such vault on that relay. Don't create one by accident.
4. `syncOnce({ relay, key, vaultId, deviceId, state: emptyState(), meta: { seen: {} } })` pulls everything and uploads this device's slot.
5. Persist locally, sealed. Tsuzuki uses `sealJSON(key, state, aad({ vaultId, purpose: 'local', deviceId }))`. For a PWA: IndexedDB for the sealed ledger, and the raw key **in memory / sessionStorage only**, never localStorage.
6. Sync again after local changes (Tsuzuki: 20 s after a change, every 15 min, and a quick pull, capped at 2.5 s, when a video opens).

Envelope: `"TZK" ‖ 0x01 ‖ iv(12) ‖ AES-GCM ciphertext+tag`. The AAD string is `tsuzuki/v1|<vaultId>|<purpose>|<deviceId>`, with purpose `sync` for relay slots.

### Relay API (all under `/v1/vaults/{vaultId}`, `Authorization: Bearer <authToken>`, CORS `*`)

`GET /blobs` (list: device, etag, size, updated_ms; 404 if the vault doesn't exist) · `GET /blobs/{device}` (supports `If-None-Match`) · `PUT /blobs/{device}` (creates the vault on first use; `x-tsuzuki-register` header if the relay requires a registration token) · `DELETE /blobs/{device}` · `DELETE /` (whole vault) · `GET /` reports source and license.

### Not in the ledger

Per-device settings (service toggles, instances, home-page prefs) are **local config, not synced**. The frontpage needs its own settings. If shared settings are ever wanted, they'd need a new, merge-safe ledger map, coordinated with Tsuzuki.

## 5. Backends to evaluate first (verify against current docs; these drift)

- **Invidious API:** `/api/v1/search?q=`, `/api/v1/videos/<id>`, `/api/v1/channels/<ucid>`, `/api/v1/trending`. Thumbnails at `/vi/<id>/mqdefault.jpg`. Streams can be proxied through the instance (the `local=true` options).
- **Piped API:** separate API host (e.g. `pipedapi.<domain>`): `/search?q=&filter=videos`, `/streams/<id>`, `/channel/<id>`.
- **PeerTube:** `/api/v1/search/videos?search=` per instance; SepiaSearch for federated search.
- **SearXNG:** `/search?q=…&format=json` (must be enabled). Gives web results from many engines at once, which is the natural "web" tab.
- **YouTube IFrame Player API:** official embedding, with progress readable via `getCurrentTime()`.
- Later or optional: Twitch Helix (needs client id + OAuth), Vimeo API (token), Nebula (no public API; link out).

## 6. Constraints and values (from the user)

- **Privacy-first and local-first.** No algorithmic recommendations; chronological, filterable and user-driven only. Don't leak the user's history to platforms: e.g. thumbnails are opt-in in Tsuzuki because loading them tells YouTube what's on the page. Prefer routing through her own instances.
- **Self-hosting is welcome.** As of this handoff she hasn't set up the relay yet. The suggestion on the table is her Windows mini PC (X2 Mini Pro) behind Tailscale (`tailscale serve` for HTTPS, free personal plan). A helper could live next to it.
- **License:** the frontpage will import AGPL code, so it must be AGPL-compatible. Simplest is AGPL-3.0-or-later too (Nat chose AGPL for Tsuzuki deliberately).
- **Devices:** Zen browser on Windows (keyboard-driven: vim user, Vimium, tiling WM), so design for keyboard navigation. An M2 MacBook Air for Safari/Xcode work. An iPhone, used through Safari after deleting most apps, so the mobile web experience matters a lot. Prefer Safari-friendly APIs.
- **Taste:** Tsuzuki's UI is "washi paper, sumi ink, a line of vermilion" (see `extension/src/ui/app.css` tokens). Nat studies Japanese (Yahoo! JAPAN is a supported engine; 続き branding). Matching that aesthetic would make the two feel like one family.
- **Working style she appreciated:**
  - Direct transparency: say clearly what's verified versus guessed, and flag ToS/privacy trade-offs.
  - Tests for everything, including jsdom runs of UI and content scripts and a real two-device sync through the relay.
  - SPDX headers on every file.
  - Commits pushed with a short summary.

## 7. Open questions to settle early in the new chat

1. PWA + helper (recommended) vs. extension page vs. both?
2. Which YouTube backend: Invidious, Piped, or both behind one interface? Does Nat run her own instance, or start with public ones?
3. Playback: embed vs. proxied streams? (Embeds are simpler and ToS-clean; proxied streams are ad-free but heavier.)
4. Subscriptions/feeds (chronological, from channels she picks): stored where? A new ledger map (needs care; see section 4) or local only at first?
5. Helper language: Rust/axum (matches the relay; Nat is practicing Rust) or something else?
6. Repo name. Tsuzuki means "continuation"; something in the same spirit could suit.

## 8. Things to coordinate back to Tsuzuki

- Any change to the ledger schema, keys or merge rules belongs in Tsuzuki first, with its tests.
- Storing KDF parameters relay-side (see section 4, step 2) would make future devices safer to add.
- If the frontpage records progress, it should use the same key namespaces (`linkForKey`/`identifyVideo` in `services.js` are the reference).
