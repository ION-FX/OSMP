# OSMP — frequently asked questions

## General

**Is this legal?**
OSMP is intended for personal use with content you have the right to play.
Streaming or downloading from YouTube may be restricted by YouTube's Terms
of Service and by copyright law in your jurisdiction — that's between you,
them and your lawyer. The project ships no circumvention of DRM; it uses
the same public streams a browser plays.

**Why YouTube as the catalog?**
It's the largest music collection in existence, needs no API key, and
yt-dlp already speaks it fluently. The trade-offs (occasional breakage when
YouTube changes, no official support) are handled server-side — update
yt-dlp and you're usually fixed in a minute.

**Does it phone home?**
No telemetry. Outbound calls: YouTube (playback/search/import), LRCLIB
(lyrics lookups), and GitHub (update checks you trigger). That's it.

**Can I play my own MP3/FLAC collection?**
Yes — that's first-class since v0.4.0. Upload files from the Library view
on any device, or (as admin) point Settings → *Import your collection* at
a folder on the server: everything is copied in with tags and cover art
read automatically, and it mixes with YouTube tracks in playlists and
search. Those files are yours; no YouTube involved.

**Can I use it alongside Plex/Jellyfin/Navidrome?**
Yes — OSMP is self-contained (one port, one SQLite file, one downloads
folder). Some people point Plex at OSMP's `downloads/` directory for the
files it fetched.

## Playback

**Tracks suddenly fail / stall mid-song.**
Almost always a yt-dlp extractor change. Settings → Updates → *Update
yt-dlp only*, wait ~30 s, play again. If the server itself can't reach
YouTube (DNS, IPv6 quirks), check `journalctl -u osmp`.

**Seeking works in the browser but not in my app?**
Seeking depends on Range requests; OSMP proxies them server-side, so any
HTTP client that implements ranges works. If something breaks, it's usually
a reverse proxy stripping `Range`/`Accept-Ranges` headers — check the
proxy config.

**Sound quality?**
Streams are the audio-only formats YouTube serves (typically AAC ~128 kbps
m4a, or Opus ~140 kbps). Downloads keep that quality and get tagged with
metadata + embedded cover.

**What's the equalizer doing to my audio?**
A three-band Web Audio filter chain (low shelf 180 Hz, peaking 1.4 kHz,
high shelf 5.2 kHz) inserted between the audio element and the speakers,
±12 dB per band. It's per-device (a browser preference, not a server
setting) and can be bypassed with one checkbox.

**Lyrics are missing for a popular song.**
They come from LRCLIB, a community database — coverage isn't universal and
quality varies. OSMP retries weekly, and rejects obviously broken entries.
For instrumental tracks, "no lyrics" is the correct answer.

## Accounts & data

**Where is my stuff?**
One SQLite file (`osmp.db`) plus `downloads/` in the data dir — see
SELF-HOSTING.md for exact paths per install type. Back up those two and
you've backed up everything.

**I forgot the admin password.**
The server shell can reset it even while the server runs:
`python3 server/run.py --reset-password admin` (venv python for systemd
installs). See README → Account recovery.

**Do listeners see each other's history?**
No. Stats, mixes, made-for-you and history are per-account. Admins can
query aggregate stats with the "Everyone" scope; individual plays stay
private to the account either way.

**What's in a backup?**
Playlists (with order), track metadata, and safe settings. Not accounts,
not sessions, not API keys — restoring on a fresh box means re-creating
users.

## Offline

**What exactly works with the server down?**
- Android: every track downloaded to the device.
- Browser/AppImage: every track you "Saved to this device" (its ⋮ menu),
  plus the whole UI shell.
- Changes you make offline (plays, likes, playlist edits) are journaled
  and sync when the server returns. Downloads obviously need it back.

**Why does 'Save to this device' need the server once?**
The audio is fetched through the server (that's where the stream comes
from); the copy is stored client-side afterwards. After that first save it
plays with zero network.

## Server

**How much resources does it need?**
~200 MB RAM idle; each concurrent stream is a proxied HTTP connection, so
bandwidth matters more than CPU. SQLite comfortably handles household-scale
libraries (thousands of tracks, tens of thousands of history rows).

**Can I run it on a Raspberry Pi?**
Yes for streaming + small libraries. yt-dlp extraction is CPU-hungry on
old ARM boards (a few seconds per resolve); downloads to the server's
library are fine overnight. The AppImage is x86_64-only — run the server
from source on ARM.

**Multiple libraries / multiple servers?**
One library per server, but nothing stops two servers on different ports.
There's no federation or cross-server sync (backups import, not merge
live).

**Why does the first play of a track take a moment?**
The server resolves the stream URL via yt-dlp (cached ~5 h afterwards),
then proxies it. Subsequent plays of the same track start immediately.

**Can I scrobble to Last.fm / ListenBrainz?**
Not built in. The play journal is plain data though — `GET /api/history/log`
returns timestamped plays for your account, which is everything a scrobbler
needs. A small cron pushing new rows to ListenBrainz is a pleasant
afternoon project.

**The updater says "up to date" but I know there's a release.**
Update checks need GitHub access (and a token for private repos — Settings
→ Updates). The check runs when you press the button, not in the
background.
