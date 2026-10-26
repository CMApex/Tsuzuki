# Tsuzuki privacy policy

*Effective 2026-10-26. Applies to the Tsuzuki browser extension and the optional tsuzuki-relay server.*

**Short version:** Tsuzuki never sends anything to its developer or to any third party. Everything it remembers stays on your device, encrypted. It only leaves your device if *you* turn on sync, and then only to a server *you* run, end-to-end encrypted so that server can't read it.

## What Tsuzuki stores, and where

On the sites you switch on in *Settings → Services*, Tsuzuki keeps a ledger on your device of:

- **where you stopped in videos** (video ID, position, length, title, channel);
- **videos you finished** (video ID, title, channel);
- **searches** you made on the search engines you switched on (the query and which engine).

The ledger is encrypted with AES-256-GCM using a key derived from your passphrase (PBKDF2-SHA256, 600,000 rounds) and stored in the extension's local storage. The developer never sees your passphrase or key, and they can't be recovered.

Tsuzuki records nothing in private windows, and nothing on sites or engines you haven't switched on.

Your settings (which services are on, your theme, custom CSS, relay URL) are stored on your device unencrypted, because they aren't history.

## What leaves your device

**By default: nothing.** Tsuzuki has no analytics, telemetry, crash reporting, ads or developer server.

**If you turn on sync** by entering the address of a relay *you* run, then:

- Firefox asks you to allow sending *browsing activity* and *search terms* (its official names for these categories). Sync stays paused until you agree, and you can withdraw consent at any time in `about:addons` → Tsuzuki → *Permissions and data*.
- Your encrypted ledger is uploaded to **your** relay. The relay stores ciphertext it cannot decrypt. It can see: a random vault ID, random device IDs, the size of each encrypted snapshot, when devices sync, and the IP addresses they connect from.

**Optional features that contact other sites**, both off by default:

- *Home page thumbnails:* loads video thumbnail images from YouTube (or from your own Invidious instance if you've added one). Like any image request, this tells that server your IP address and which videos are shown.
- *Instances:* if you add an Invidious, Piped, PeerTube or SearXNG server, Tsuzuki runs on that site the same way it runs on the built-in services.

## What the sites you visit can see

Tsuzuki doesn't change what YouTube, Google and the other sites already learn from your visits. Resuming a video is equivalent to opening a link with a timestamp. Progress bars on thumbnails are drawn so that the site's own scripts can't read them.

## Exporting and deleting

*Settings → Your data* lets you export your ledger as JSON (not encrypted, so handle it like the history it is), import it, or wipe this device. Wiping can also delete this device's copy from your relay. Uninstalling the extension removes its local data.

## Changes and contact

Changes to this policy are made in the public repository, <https://github.com/CMApex/Tsuzuki>, where its full history is visible. Questions: open an issue there.
