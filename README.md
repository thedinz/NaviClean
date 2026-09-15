# NaviClean

NaviClean is a Docker-first cleaner and organizer for Navidrome music libraries.
It scans a mounted music library, browses artists, albums, and tracks, previews clean artist/album/track paths, and only unlocks duplicate cleanup after organization is complete.

## Latest changes on `dev` — September 14, 2026

- **Identity before organization:** optional AcoustID/MusicBrainz fingerprint matching, release selection, reusable confirmed identities, and canonical tag writing before moves. TrackKeep identities and prior user confirmations remain authoritative; Spotify matching can be switched off.
- **Clearer dashboard and scan controls:** Library overview shows Tracks, Duplicate groups, Pending moves, and Identity review, with a three-step Cleanup workflow. Identity review counts tracks awaiting identity confirmation; Organize's broader **Needs action** filter also includes ready moves, conflicts, and missing files. The **Index & scans** panel separates NaviClean's **Run scan** from Navidrome's **Quick scan** and **Full scan**.
- **Simpler Organize review:** identity-focused filters, a combined current/proposed path column, an **Apply** button with the ready count, and collapsible index notes. Additional filters are under **More filters**, and selection actions appear when needed.
- **Better setup and cleanup states:** Discover links to Settings when Spotify is off or lacks credentials; Empty Folders and Non-Music Files show library-access errors instead of misleading empty results. Duplicate blockers, Diagnostics controls, and Trash selection/empty states are less cluttered.
- **Settings and navigation improvements:** configuration status labels, a sticky save bar with unsaved-change feedback, dark-mode fixes, a tablet navigation rail, a mobile menu, and a scrollable sidebar for short screens. Branch labels now come from the build instead of always showing `main`.
- **Runtime and planning:** Docker now includes Chromaprint's `fpcalc`; the [UI roadmap](docs/ui-roadmap.md) records the design review that preceded the UI work. Its original planning status and some proposed controls predate the implementation described here.

## Current defaults

- Web UI: `http://localhost:8080`
- Login: `admin` / `admin`
- Config volume: `/data`
- Music volume: `/music`
- Runtime user: `PUID=1000`, `PGID=1000`
- Reverse proxy: `NAVICLEAN_TRUST_PROXY=1`, `NAVICLEAN_SECURE_COOKIES=auto`, `NAVICLEAN_COOKIE_SAMESITE=lax`
- Advanced diagnostics: `NAVICLEAN_ADVANCED_DIAGNOSTICS=1` shows the internal Diagnostics page and enables its matching-inspection API routes
- Image: `ghcr.io/thedinz/naviclean:latest`

## Docker Compose

```yaml
services:
  naviclean:
    image: ghcr.io/thedinz/naviclean:latest
    container_name: naviclean
    restart: unless-stopped
    ports:
      - "${NAVICLEAN_PORT:-8080}:8080"
    environment:
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}
      NAVICLEAN_DATA_DIR: /data
      NAVICLEAN_MUSIC_DIR: /music
      NAVICLEAN_TRUST_PROXY: ${NAVICLEAN_TRUST_PROXY:-1}
      NAVICLEAN_SECURE_COOKIES: ${NAVICLEAN_SECURE_COOKIES:-auto}
      NAVICLEAN_COOKIE_SAMESITE: ${NAVICLEAN_COOKIE_SAMESITE:-lax}
      NAVICLEAN_ADVANCED_DIAGNOSTICS: ${NAVICLEAN_ADVANCED_DIAGNOSTICS:-0}
    volumes:
      - ${NAVICLEAN_DATA_PATH:-./data}:/data
      - ${NAVICLEAN_MUSIC_PATH:-./music}:/music
```

For Unraid, set `PUID=99` and `PGID=100` so NaviClean can write to `/mnt/user/appdata/naviclean` and the mounted music share.

## Naming model

NaviClean keeps one stable standard naming contract:

- Artist folder: `{Album Artist Name}`
- Standard track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}`
- Multi-disc track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}`

NaviClean appends the original extension before planning moves. A normal standard target path looks like `Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track`. Missing release years are written as `Unknown Year`. In standard mode, the rendered target path is canonical, so a different year, folder name, or filename is treated as organization work instead of being accepted as close enough.

## Audio identification setup

In **Settings → Audio identification**, enable **AcoustID / MusicBrainz** and enter an AcoustID application API key. Lookup is off by default. The key can also be supplied through `ACOUSTID_API_KEY` when initializing settings; enabling lookup remains a separate setting. Docker includes `fpcalc`; local installations need it available on `PATH` for fingerprinting.

| Setting | Default | Behavior |
| --- | --- | --- |
| AcoustID / MusicBrainz | Off | Looks up audio fingerprints for recording and release candidates when enabled with an API key. |
| Embedded tags as hints | On | Allows ordinary tags to supply search hints. |
| Paths as hints | On | Allows filenames and folders to supply search hints. |
| Accept unique fingerprint + release matches | On | Accepts a unique qualifying recording/release match, including release consensus among tracks in a folder. |
| Require review before file changes | On | Keeps automatically matched tracks in identity review until confirmed. |

Spotify matching has its own **Enable Spotify matching** switch under **Settings → Spotify catalog**. It defaults to on, but needs a client ID and secret to search. Discover shows a setup prompt and an **Open Settings** action when it is disabled or unconfigured. Settings labels report configuration state; use the connection test actions to check connectivity.

## Recommended workflow

Existing library files are organized only after their identity is confirmed. TrackKeep tags and prior user decisions are authoritative. When enabled, NaviClean calculates a Chromaprint fingerprint with `fpcalc`, asks AcoustID for MusicBrainz recording and release candidates, and requires ambiguous releases to be selected in Organize. Unique fingerprint-and-release matches can be accepted automatically, while the safer default still requires confirmation before file changes. Ordinary embedded tags, filenames, and folders are optional search hints rather than identity authority. Confirmed decisions are stored by audio fingerprint so they survive file moves, retagging, and compatible format changes.

Spotify matching is optional and has an explicit Settings switch. Each Organize row can search Spotify using the available hints; metadata is used only after the user chooses a result. Navidrome is used for index diagnostics, artwork, and scan coordination, but its cached copy of local tags does not replace confirmed NaviClean metadata.

Use this flow when cleaning a mounted Navidrome library:

1. On **Dashboard → Index & scans**, run **Full scan** for Navidrome and wait for it to finish. Configure the Navidrome connection in Settings to use these controls, or start the scan in Navidrome itself.
2. Select **Run scan** beside **NaviClean library scan**. This reads the mounted library, fingerprints unidentified audio when AcoustID/MusicBrainz is enabled, and checks Navidrome index status. NaviClean and Navidrome scans update separate catalogs.
3. Open **Organize**, preview changes, and resolve **Identity review** rows by confirming a MusicBrainz release or choosing a Spotify result. A MusicBrainz release confirmation also applies to fingerprinted tracks in the same folder that have a candidate for that release. Review the refreshed current/proposed paths, resolve conflicts/missing files, and select **Apply** for ready items. NaviClean stream-copies the audio into a safely retagged file, preserving other embedded tags and artwork, before moving it to the canonical path. If tag writing fails, the original stays in place and the move is not applied.
4. Run a full Navidrome scan/sync again so Navidrome sees the new paths and any new tags.
5. Run a fresh NaviClean scan before doing another organization or duplicate-cleanup pass.

This keeps NaviClean and Navidrome looking at the same library state. Navidrome can report stale paths after a large move until its next scan; those index notes do not override confirmed NaviClean identity or naming metadata.

## Spotify catalog discovery

The Discover page can connect to Spotify with client credentials, search catalog artists, show album discographies beside local library coverage, and stage missing album tracks for provider download. Users can select an album's full track list; provider discovery runs in bounded batches and reports checked/total progress as each batch completes. Spotify is used for metadata and artwork only; downloads come from configured external providers and require the user to confirm they are authorized to download the selected tracks. YouTube downloads share one global queue, wait at least 10 seconds between tracks, and pause for 2 minutes after every 5 attempts. Active jobs continue on the server if the user leaves Discover, and the page reconnects after navigation or a refresh. The Docker image includes `ffmpeg` and current `yt-dlp` for YouTube/JioSaavn provider jobs.

Provider downloads default to Ogg Opus with a 192 kbps quality cap. Settings offers 160, 192, and 256 kbps Opus caps. These are maximums: valid provider audio below the selected bitrate is kept at source quality instead of being upconverted, while audio above the cap is normalized with `libopus`. If Opus cannot be written because of an audio-format, encoder, ffmpeg, header, or postprocessing failure, NaviClean retries the same source as MP3 by default. MP3 fallback can be disabled or set to 192, 256, or 320 kbps (320 kbps by default), uses `libmp3lame`, and writes ID3v2.3 metadata.

NaviClean provider downloads use the same standard target-path renderer as the organizer and dual-write TrackKeep Identity Tags v1 in the current `trackkeep:*` namespace and the legacy `spotifybu:*` namespace. The fields are `track_id`, `track_uri`, `album_id`, `isrc`, and `identity_version`. Those tags let later scans recognize files as TrackKeep-managed so NaviClean does not keep re-organizing provider downloads, even after a file is moved or renamed. NaviClean reads either namespace in canonical colon, underscore, Apple/iTunes freeform, and ID3/native forms, case-insensitively. It also recognizes M4A comment JSON beginning with `TrackKeep identity ` or the legacy `SpotifyBU identity ` prefix. The legacy namespace and prefix remain supported solely for compatibility with files and companion releases from before the TrackKeep rename. Opus files use Navidrome-compatible Vorbis comments and embed cover art as `METADATA_BLOCK_PICTURE`; the large picture block is passed to ffmpeg through a temporary ffmetadata file so it does not consume command-line argument space.

## Library artwork

When Navidrome connection settings are saved, NaviClean uses the local Navidrome Subsonic API to resolve artist and album artwork for Library cards. Artwork is proxied through NaviClean so browser image requests use the existing NaviClean session instead of exposing Navidrome tokens. Cards fall back to generated identity tiles when Navidrome is not configured or does not return artwork.

## Audio conversion

The Convert page groups the latest scan catalog by source extension and lets you convert selected tracks to MP3, FLAC, M4A, Opus, Ogg, or WAV with `ffmpeg`. Conversions stay inside the configured music library, write to a temporary output first, delete the original only after a successful conversion, and trigger a fresh NaviClean scan when the job completes.

## Local development

```bash
npm install
npm run dev
```

The Vite UI runs on `5173` and proxies API requests to the server on `8080`. Install `ffmpeg` for retagging/conversion and Chromaprint's `fpcalc` for audio identification.

The UI branch label uses `VITE_APP_BRANCH` when supplied, otherwise Vite reads the current Git branch (falling back to `unknown`). GitHub Docker builds supply the ref name automatically. For a manual Docker build, pass `--build-arg VITE_APP_BRANCH=dev` to label a development image.

## Safety

Cleanup is staged: scan first, organize second, then review duplicates. The Library page can also move selected artists, albums, or tracks to the recycle bin. Duplicate cleanup stays locked while organization has pending moves, conflicts, or missing files, but target collisions that match duplicate candidates are allowed through so the duplicate review can break the loop. The organize preview also shows collision candidates with quality details and can move a selected blocker to the recycle bin. Duplicate groups require the same organized album identity, disc/track number, title/version text, and duration or ISRC. Removed files are moved into the configured recycle bin path, preserving their relative path under a timestamped folder, and can be reviewed or permanently emptied from the Trash page.

## References

- Navidrome Subsonic API compatibility: <https://www.navidrome.org/docs/developers/subsonic-api/>
