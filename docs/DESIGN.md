# Tsuzuki design notes

## Goals

1. Give back the *conveniences* of server-side history (resume, watched markers, search recall) with none of it stored by the platform.
2. Keep the ledger encrypted at rest, and readable only with the user's passphrase.
3. Sync across browsers and OSes (Firefox ⇄ Safari) without trusting the sync server.
4. Never build a recommendation engine. The ledger is shown newest-first, filterable, and that's it.

## The ledger

Three maps of last-writer-wins registers (`extension/src/core/model.js`):

| map        | key             | value                                  |
|------------|-----------------|----------------------------------------|
| `resume`   | `yt:<videoId>`  | `{ at, dev, t, dur, title?, ch? }`     |
| `watched`  | `yt:<videoId>`  | `{ at, dev, title?, ch? }`             |
| `searches` | random id       | `{ at, dev, q, src }`                  |

Any value may instead be a tombstone `{ at, dev, del: true }`.

**Merge** takes, per key, the record that is greatest under `(at, dev, canonical JSON)`. That order is total, so merge is a join on a semilattice: commutative, associative, idempotent. `test/model.test.mjs` checks those laws on 200 random three-device histories. Consequences:

- Devices can exchange snapshots in any order, any number of times, and converge.
- A replayed or stale snapshot can't undo anything newer.
- There's nothing to lock and no conflicts to resolve.

**Clocks.** `at` is wall-clock milliseconds, except that a local write to a key always gets `max(now, existing.at + 1)`. So a device whose clock lags can still overwrite or forget a record it has already seen (tested in `sync-e2e.test.mjs` with a phone 5 minutes behind). What it can't do is beat a concurrent write it hasn't seen from a device with a faster clock, which is the usual LWW trade-off and fine for this data.

**Policy.** Positions under 15 s aren't remembered. A video counts as finished at 90 % or with fewer than 25 s left (end cards); finishing tombstones the resume point and records `watched`. Identical searches from the same engine within 10 minutes are one search.

Tombstones are never pruned yet. They're tiny; GC would need a "seen by every device" watermark.

## Crypto

`extension/src/core/crypto.js`, WebCrypto only (same code in Firefox, Safari, Node).

```
master  = PBKDF2-SHA256(NFKC(passphrase), salt = "tsuzuki/v1/salt/" + vaultId, 600 000 iterations)
encKey  = HKDF-SHA256(master, info = "tsuzuki/v1/enc")          AES-256-GCM key, never leaves devices
token   = HKDF-SHA256(master, info = "tsuzuki/v1/relay-auth")   bearer token for the relay
```

The vault id is 128 random bits created with the vault; it is the salt and the relay namespace. It isn't secret.

Envelopes: `"TZK" ‖ 0x01 ‖ iv(12) ‖ ciphertext+tag`, with additional authenticated data `tsuzuki/v1|vaultId|purpose|deviceId`. Purpose is `local` (the copy in `storage.local`) or `sync` (a relay slot). Binding the device id means the relay can't present one device's blob as another's; binding the purpose keeps local and sync blobs from being swapped.

No compression before encryption, so blob sizes don't vary with content in a way an observer could probe (sizes still grow with the amount of history).

**Unlocking.** The derived key material lives in `storage.session` while unlocked. That survives Safari killing the background worker (which it does constantly on iOS) but not a browser restart, at which point the vault locks. Events captured while locked queue in `storage.session` (memory only) and are applied on unlock. Older Safari without `storage.session` falls back to worker memory.

## Relay protocol

All under `/v1/vaults/{vaultId}`, `Authorization: Bearer <token>`:

| method & path              | meaning |
|----------------------------|---------|
| `GET /blobs`               | `{ blobs: [{ device, etag, size, updated_ms }] }`; 404 if the vault doesn't exist |
| `GET /blobs/{device}`      | the blob; `ETag`; honours `If-None-Match` |
| `PUT /blobs/{device}`      | store the blob (creates the vault on first use) → `{ etag }` |
| `DELETE /blobs/{device}`   | remove one device's slot |
| `DELETE /`                 | remove the whole vault |

The relay stores `SHA-256(token)` on first PUT (trust on first use) and compares in constant time afterwards. Ids must be 16–64 URL-safe characters, which rules out path traversal by construction. `TSUZUKI_REGISTER_TOKEN` gates *creating* vaults on public relays. Writes are atomic (temp file + rename).

**Sync round** (`syncOnce`): list slots → download and merge any other slot whose etag changed → if the canonical ledger hash differs from the last upload, re-encrypt and PUT our slot. Every slot is a full snapshot, so removing a device's slot loses nothing that other devices have seen.

When joining, the device first lists the vault: a 401 means the passphrase is wrong, an empty list means the vault code is wrong. Nothing is saved locally until a join fully succeeds.

Sync runs 20 s after a change, every 15 minutes, on unlock, on demand, and as a quick pull (≤ 2.5 s) when a video opens, so the phone sees where the desktop stopped.

## Threat model

| party | can see | can't |
|-------|---------|-------|
| YouTube / Google | everything they already saw: each video you load, each search, your IP. Resuming looks like opening a `&t=` link. | your local ledger. Thumbnail markers are uniform and closed-shadow, so page scripts can't read which videos have progress. |
| The relay operator | vault id, device ids, blob sizes, sync times, IPs | read, forge, or meaningfully roll back data. It can withhold or replay blobs; replay is a no-op under the CRDT, withholding only delays sync. |
| Someone with your disk | that Tsuzuki is installed, the vault id, how big the ledger is | contents without the passphrase (offline guessing costs 600k PBKDF2 rounds per guess). |
| Someone with your unlocked browser | everything; it's your history | — |

Things that would weaken this, deliberately not done: storing the key in `storage.local` for convenience; compressing before encrypting; showing progress only on seen thumbnails.

Private windows: Firefox gets `incognito: not_allowed`; content scripts also check `inIncognitoContext` and do nothing.

## Known gaps / next

- Passphrase change (needs a re-key: new vault id + re-upload from one device, others re-join).
- Tombstone GC.
- More sites: Twitch VODs, Nebula, PeerTube, podcasts. The model's keys are already namespaced (`yt:`).
- The YouTube app on iOS is invisible to a Safari extension.
- A desktop companion (Rust) that reads the relay blobs with the passphrase and browses the whole ledger offline.
