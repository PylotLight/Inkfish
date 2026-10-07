# Inkfish sync — Mac ↔ Android, peer-to-peer, no server

Status: **design / proposal** (nothing implemented yet). 2026-10-08.

## Goals

- Mac and phone sync **directly**. No Inkfish server, no account, no cloud copy.
- Works on the same Wi-Fi **and** away from home (phone on 5G, Mac at home).
- Files stay the source of truth: the `.md` + `assets/` tree on each device is
  what syncs. No database is ever authoritative.
- End-to-end encrypted, paired devices only.
- Never lose a word: concurrent edits merge, and when they can't, both copies survive.

## The honest constraint

Two devices behind home/mobile NAT can't find each other with literally zero
third parties. Something has to broker the first packet. The options are:

| Option | Who runs it | What it sees | Works away from home |
| --- | --- | --- | --- |
| LAN only (mDNS) | nobody | nothing | no |
| Public relay (n0's free iroh relays) | number0 | encrypted QUIC only, never content | yes |
| Your own relay (`iroh-relay` on a VPS / home box / Tailscale) | you | encrypted QUIC only | yes |
| Relay **inside the Mac app** | you | nothing new | only if the Mac is publicly reachable (port-forward / Tailscale Funnel) |

The relay is only used to hole-punch and as a fallback pipe. iroh upgrades to a
direct UDP path whenever the network allows (most home routers do), so in
practice the relay carries little or nothing.

**Proposal:** default to n0 public relays (zero setup), with Settings options
for *LAN only* and *Custom relay URL*. An "inbuilt relay" mode can be added
later as an advanced toggle for people who port-forward, but it can't be the
default because a NATed Mac can't relay for anyone.

## Transport: iroh 1.0

iroh (n0.computer) shipped 1.0 in June 2026 with official bindings that cover
both our runtimes:

- **Mac (Electron main):** `@number0/iroh` — napi-rs, prebuilt `darwin-arm64`
  binary, Node ≥ 20.3. napi is ABI-stable, so no electron-rebuild per Electron bump.
- **Android:** `computer.iroh:iroh` on Maven Central (uniffi Kotlin). Wrapped in
  a small **Expo Module** (Kotlin) that exposes `bind / connect(ticket) /
  accept / openBi / read / write / close` to JS. Needs the dev-client/APK build
  we already have (not Expo Go).

Why iroh: dial by public key (not IP), QUIC + TLS 1.3 to that key, hole punching,
local discovery, relay fallback, multipath when Wi-Fi ↔ 5G changes mid-sync.

Rejected: libp2p (heavy, RN support poor), WebRTC (needs a signalling server
anyway), raw WebSocket on LAN (no away-from-home story), SpacetimeDB/
CouchDB-style replicas (server-shaped).

## Pairing

1. Mac › Settings › Sync › **Pair a phone** shows a QR: iroh ticket (EndpointId +
   relay URL + direct addrs) + a one-time 128-bit pairing code, valid 5 min.
2. Phone scans, connects on ALPN `inkfish/pair/1`, proves the code.
3. Both store the other's EndpointId (ed25519 public key) + a device name in
   `.inkfish/sync/peers.json`. From then on, ALPN `inkfish/sync/1` accepts
   only known peers; unknown keys are dropped before any data is read.
4. Unpair = delete the key on either side.

Each device's iroh secret key lives in the OS keystore (macOS Keychain via
`safeStorage`, Android Keystore via `expo-secure-store`).

## Sync model: files + three-way merge

Each device keeps a small state file per peer:
`.inkfish/sync/state-<peer>.json` → `{ path: { hash, size, mtime, baseHash } }`,
where `baseHash` is the content both sides agreed on at the last sync. Base
contents for `.md` files are cached in `.inkfish/sync/base/<hash>` (text only,
tiny) so merges are possible.

A sync session:

1. **Manifest exchange** — each side sends `path → hash` for vault + staging
   (`inbox/`, `daily/`), plus tombstones for deletions since last sync.
2. **Classify** each path against `baseHash`:
   - unchanged → skip
   - changed on one side → copy that version over
   - deleted on one side, untouched on the other → delete
   - changed on both → **merge** (below)
   - deleted on one, edited on the other → keep the edit (edits beat deletes)
3. **Transfer** — content-addressed by hash, so a renamed/moved file or an
   asset already present is never re-sent. Large assets stream in chunks with
   resume.
4. **Commit** — write files atomically (temp + rename), update state + base
   cache, then the Mac re-indexes changed paths (FTS) as it does for edits today.

### Merge rules

| File | Rule |
| --- | --- |
| Notes `.md` | Frontmatter merged per key (newest `updated` wins per key; `tags` = union). Body: three-way diff3 (`node-diff3`, pure JS — runs in Electron and Hermes). Clean merge → write it. Overlap → keep ours, write theirs as `Title (conflict · Pixel · 2026-10-08 09:14).md` next to it, and flag it in Inbox. |
| `daily/YYYY-MM-DD.md` | Append-only log: union of `## HH:MM` sections, dedupe identical, sort by time. Never conflicts. |
| `inbox/<id>.md` | Ids are unique per capture; status changes are frontmatter-only → per-key merge. |
| `assets/**` | Immutable, unique names → never conflict. |
| Folders | Implicit from paths; a rename is delete + add of the same hash, detected and applied as a move. |

Why not a CRDT (Loro/Automerge) now: they need native or WASM bindings in
Hermes, and they want to own the document — a second source of truth next to
the `.md`. For one person on two devices, diff3 + conflict copies (what
Obsidian Sync and Syncthing effectively do) is enough. A CRDT stays the
upgrade path if we ever want live co-editing.

## When sync runs

- **Mac:** listens whenever the app is running (it's already a menu-bar app).
  Watches the vault (chokidar) and pushes to connected peers after a 2 s quiet period.
- **Android:** on app open, after each capture/save, pull-to-refresh, and a
  WorkManager periodic job (Android minimum 15 min; best-effort). No permanent
  background socket — battery first.
- Both: a **Sync now** button and a status line ("Synced 2 min ago · direct" /
  "· via relay" / "Mac not reachable").

## Android vault location (worth deciding now)

Today the Android vault is app-private (`/data/user/0/…/files/inkfish/vault`).
Letting the user pick a shared folder via the Storage Access Framework would
let Obsidian Android, file managers and backups see the same notes. Costs: SAF
I/O is slower and URI-based. Suggest: keep private by default, add "Store vault
in a folder you choose" later.

## Plan

1. **sync-core (TS, shared, no I/O):** manifest diff, classify, diff3 merge,
   daily union, frontmatter merge. Unit tests with fixture vaults. Used by
   both Mac and Android.
2. **Mac transport:** `@number0/iroh` endpoint in main, pairing QR, Settings › Sync.
3. **Android transport:** Expo Module over `computer.iroh:iroh`, QR scan
   (`expo-camera`), Settings › Sync, sync on open/capture.
4. **Hardening:** resume, big assets, WorkManager, conflict UI in Inbox, relay
   choice (n0 / custom / LAN only).
5. **Later:** optional encrypted backup to the user's own storage (S3/iCloud
   Drive) as a third "peer", CRDT for live co-edit, SAF vault folder.

## Open questions

- Is n0's public relay acceptable as the default, or LAN-only by default with
  relay opt-in?
- Should the phone be able to sync with *several* Macs (work + home)? The
  design supports N peers; UI would list them.
- Transcription: Android voice memos still transcribe on Mac after sync — Mac
  could write the transcript back into the inbox item so the phone sees it.
