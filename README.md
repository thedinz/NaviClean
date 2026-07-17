# NaviClean

NaviClean is a Docker-first cleaner and organizer for Navidrome music libraries.
It scans a mounted music library, browses artists, albums, and tracks, previews clean artist/album/track paths, and only unlocks duplicate cleanup after organization is complete.

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

NaviClean uses one selected naming mode at a time:

- `Standard` is the default for fresh installs:
  - Artist folder: `{Album Artist Name}`
  - Standard track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}`
  - Multi-disc track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}`
- `Manual` keeps the editable templates for users who want to define their own folder and file layout.

NaviClean appends the original extension before planning moves. A normal standard target path looks like `Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track`. Missing release years are written as `Unknown Year`. In standard mode, the rendered target path is canonical, so a different year, folder name, or filename is treated as organization work instead of being accepted as close enough.

## Recommended workflow

Existing library files are organized from the scan catalog, with Navidrome metadata used when Navidrome can match the file. Artist/album identities that depend on folder or filename inference enter a blocking Metadata review state instead of being silently accepted. Each Organize row can search Spotify using the artist and track title, without treating the current folder or album text as authoritative. NaviClean only uses a result after the user chooses the exact release, then updates the selected track and any unambiguous title/track matches in the same source folder. For a known-good folder, **Trust this folder** confirms its complete artist/album suggestion in bulk. Spotify and trusted-path decisions are persisted across scans and file moves. The refreshed target paths are shown for review before Apply. Spotify also supplies metadata and artwork for the Discover/download flow.

Use this flow when cleaning a mounted Navidrome library:

1. Run a full Navidrome scan/sync first and wait for it to finish.
2. Run a NaviClean scan. This reads the files and enriches matched tracks from Navidrome.
3. Preview organization in NaviClean, resolve conflicts/missing files, and apply the moves.
4. Run a full Navidrome scan/sync again so Navidrome sees the new paths and any new tags.
5. Run a fresh NaviClean scan before doing another organization or duplicate-cleanup pass.

This keeps NaviClean and Navidrome looking at the same library state. If Navidrome is stale after a large move, a later NaviClean scan may appear to find new organization work because Navidrome has finally caught up with different metadata/path information.

## Spotify catalog discovery

The Discover page can connect to Spotify with client credentials, search catalog artists, show album discographies beside local library coverage, and stage missing album tracks for provider download. Users can select an album's full track list; provider discovery runs in bounded batches and reports checked/total progress as each batch completes. Spotify is used for metadata and artwork only; downloads come from configured external providers and require the user to confirm they are authorized to download the selected tracks. The Docker image includes `ffmpeg` and current `yt-dlp` for YouTube/JioSaavn provider jobs.

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

The Vite UI runs on `5173` and proxies API requests to the server on `8080`.

## Safety

Cleanup is staged: scan first, organize second, then review duplicates. The Library page can also move selected artists, albums, or tracks to the recycle bin. Duplicate cleanup stays locked while organization has pending moves, conflicts, or missing files, but target collisions that match duplicate candidates are allowed through so the duplicate review can break the loop. The organize preview also shows collision candidates with quality details and can move a selected blocker to the recycle bin. Duplicate groups require the same organized album identity, disc/track number, title/version text, and duration or ISRC. Removed files are moved into the configured recycle bin path, preserving their relative path under a timestamped folder, and can be reviewed or permanently emptied from the Trash page.

## References

- Navidrome Subsonic API compatibility: <https://www.navidrome.org/docs/developers/subsonic-api/>
