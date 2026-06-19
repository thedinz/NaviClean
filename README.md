# NaviClean

NaviClean is a Docker-first cleaner and organizer for Navidrome music libraries.
It scans a mounted music library, previews SpotifyBU-compatible Lidarr artist/album/track paths, and only unlocks duplicate cleanup after organization is complete.

## Current defaults

- Web UI: `http://localhost:8080`
- Login: `admin` / `admin`
- Config volume: `/data`
- Music volume: `/music`
- Runtime user: `PUID=1000`, `PGID=1000`
- Reverse proxy: `NAVICLEAN_TRUST_PROXY=1`, `NAVICLEAN_SECURE_COOKIES=auto`, `NAVICLEAN_COOKIE_SAMESITE=lax`
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
    volumes:
      - ${NAVICLEAN_DATA_PATH:-./data}:/data
      - ${NAVICLEAN_MUSIC_PATH:-./music}:/music
```

For Unraid, set `PUID=99` and `PGID=100` so NaviClean can write to `/mnt/user/appdata/naviclean` and the mounted music share.

## Naming model

NaviClean uses one selected naming source at a time:

- `SpotifyBU` is the default for fresh installs and uses the same fixed artist/album layout as SpotifyBU:
  - Artist folder: `{Album Artist Name}`
  - Standard track: `{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}`
  - Multi-disc track: `{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}`
- `Lidarr` stores a Lidarr URL and API key, then loads `artistFolderFormat`, `standardTrackFormat`, `multiDiscTrackFormat`, `replaceIllegalCharacters`, and `colonReplacementFormat` from Lidarr's `/api/v1/config/naming` endpoint.
- `Manual` keeps the editable NaviClean templates for users who want to define their own folder and file layout.

NaviClean appends the original extension before planning moves. Missing release years are written as `Unknown Year`, and missing disc numbers default to disc `01` for the SpotifyBU filename prefix.

## Local development

```bash
npm install
npm run dev
```

The Vite UI runs on `5173` and proxies API requests to the server on `8080`.

## Safety

Cleanup is staged: scan first, organize second, then review duplicates. Duplicate cleanup stays locked while organization has pending moves, conflicts, or missing files. Duplicate groups require the same organized album identity, disc/track number, title/version text, and duration or ISRC. Removed files are moved into the configured recycle bin path, preserving their relative path under a timestamped folder.

## References

- Lidarr naming settings: <https://wiki.servarr.com/lidarr/settings>
- Navidrome Subsonic API compatibility: <https://www.navidrome.org/docs/developers/subsonic-api/>
