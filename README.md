# NaviClean

NaviClean is a Docker-first cleaner and organizer for Navidrome music libraries.
It scans a mounted music library, previews Lidarr-compatible artist/album/track paths, detects likely duplicate tracks across file names and extensions, and gives you a web UI for applying changes.

## Current defaults

- Web UI: `http://localhost:8080`
- Login: `admin` / `admin`
- Config volume: `/data`
- Music volume: `/music`
- Runtime user: `PUID=1000`, `PGID=1000`
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
    volumes:
      - ${NAVICLEAN_DATA_PATH:-./data}:/data
      - ${NAVICLEAN_MUSIC_PATH:-./music}:/music
```

For Unraid, set `PUID=99` and `PGID=100` so NaviClean can write to `/mnt/user/appdata/naviclean` and the mounted music share.

## Naming model

The default naming templates follow Lidarr's documented shape:

- Artist folder: `{Artist Name}`
- Standard track: `{Album Title}/{track:00} {Track Title}`
- Multi-disc track: `{Album Title}/{medium:00}-{track:00} {Track Title}`

NaviClean appends the original extension and replaces illegal filesystem characters before planning moves.

## Local development

```bash
npm install
npm run dev
```

The Vite UI runs on `5173` and proxies API requests to the server on `8080`.

## Safety

Organization starts as a preview. Duplicate resolution moves removed files into the configured recycle bin path by default, preserving their relative path under a timestamped folder.

## References

- Lidarr naming settings: <https://wiki.servarr.com/lidarr/settings>
- Navidrome Subsonic API compatibility: <https://www.navidrome.org/docs/developers/subsonic-api/>
