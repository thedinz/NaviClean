#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  group_name="$(getent group "$PGID" | cut -d: -f1 || true)"
  if [ -z "$group_name" ]; then
    group_name="naviclean"
    groupadd -g "$PGID" "$group_name"
  fi

  user_name="$(getent passwd "$PUID" | cut -d: -f1 || true)"
  if [ -z "$user_name" ]; then
    user_name="naviclean"
    useradd -u "$PUID" -g "$PGID" -d /app -s /usr/sbin/nologin "$user_name"
  fi

  mkdir -p "$NAVICLEAN_DATA_DIR" "$NAVICLEAN_MUSIC_DIR"
  chown -R "$PUID:$PGID" "$NAVICLEAN_DATA_DIR" 2>/dev/null || true

  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
