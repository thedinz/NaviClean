import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { getSpotifyAlbumDetail } from "../src/server/spotify.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("Spotify album detail hydrates track ISRC values", async () => {
  const originalFetch = globalThis.fetch;
  let trackDetailCalls = 0;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({
        access_token: "test-token",
        expires_in: 3600
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/albums/album-1") {
      return jsonResponse({
        album_type: "album",
        artists: [{ id: "artist-1", name: "Album Artist" }],
        external_urls: { spotify: "https://open.spotify.com/album/album-1" },
        id: "album-1",
        images: [],
        name: "Album Name",
        release_date: "2026-01-02",
        total_tracks: 1,
        tracks: {
          items: [
            {
              artists: [{ id: "artist-1", name: "Album Artist" }],
              disc_number: 1,
              duration_ms: 180000,
              explicit: false,
              external_urls: { spotify: "https://open.spotify.com/track/track-1" },
              id: "track-1",
              name: "Track Name",
              track_number: 1
            }
          ]
        }
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/tracks") {
      trackDetailCalls += 1;
      assert.equal(url.searchParams.get("ids"), "track-1");
      return jsonResponse({
        tracks: [
          {
            artists: [{ id: "artist-1", name: "Album Artist" }],
            disc_number: 1,
            duration_ms: 180000,
            explicit: false,
            external_ids: { isrc: "usabc2100001" },
            external_urls: { spotify: "https://open.spotify.com/track/track-1" },
            id: "track-1",
            name: "Track Name",
            track_number: 1
          }
        ]
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const album = await getSpotifyAlbumDetail(settings(), [], "album-1");

    assert.equal(trackDetailCalls, 1);
    assert.equal(album.tracks[0]?.isrc, "USABC2100001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    status
  });
}

function settings(): PrivateSettings {
  return {
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: ""
    },
    navidrome: {
      baseUrl: "",
      username: "",
      password: ""
    },
    catalog: {
      spotify: {
        clientId: "client-id",
        clientSecret: "client-secret",
        market: "US"
      },
      providers: {
        maxConcurrentDownloads: 1
      },
      discovery: {
        requestsPerMinute: 40
      }
    },
    naming: {
      mode: "standard",
      libraryPath: "/music",
      recycleBinPath: path.join("/music", ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: {
      autoScanEnabled: true,
      autoScanTime: "02:00",
      extensions: [".mp3"]
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}
