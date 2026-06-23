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

NaviClean uses one selected naming mode at a time:

- `Standard` is the default for fresh installs and matches SpotifyBU's built-in organizer layout:
  - Artist folder: `{Album Artist Name}`
  - Standard track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}`
  - Multi-disc track: `{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}`
- `Manual` keeps the editable templates for users who want to define their own folder and file layout.

NaviClean appends the original extension before planning moves. A normal standard target path looks like `Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track`. Missing release years are written as `Unknown Year`. In standard mode, the rendered target path is canonical, so a different year, folder name, or filename is treated as organization work instead of being accepted as close enough. This keeps NaviClean's organizer using the same exact path formula as SpotifyBU.

## Library artwork

When Navidrome connection settings are saved, NaviClean uses the local Navidrome Subsonic API to resolve artist and album artwork for Library cards. Artwork is proxied through NaviClean so browser image requests use the existing NaviClean session instead of exposing Navidrome tokens. Cards fall back to generated identity tiles when Navidrome is not configured or does not return artwork.

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
