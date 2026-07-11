import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { providerMetadataArgsForSpotifyTrack } from "../src/server/providers.js";
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

test("NaviClean provider tags Spotify compilation albums for Navidrome", () => {
  const tags = metadataTags(providerMetadataArgsForSpotifyTrack(providerTrack({ albumType: "compilation" })));

  assert.equal(tags.title, "Track Name");
  assert.equal(tags.artist, "Track Artist");
  assert.equal(tags.album, "Compilation Album");
  assert.equal(tags.album_artist, "Various Artists");
  assert.equal(tags.track, "7");
  assert.equal(tags.disc, "2");
  assert.equal(tags.isrc, "USABC2100001");
  assert.equal(tags.date, "2026-01-02");
  assert.equal(tags.releasedate, "2026-01-02");
  assert.equal(tags.compilation, "1");
  assert.equal(tags["spotifybu:track_id"], "track-1");
});

test("NaviClean provider tags non-compilation albums without compilation marker", () => {
  const tags = metadataTags(providerMetadataArgsForSpotifyTrack(providerTrack({ albumType: "album" })));

  assert.equal(tags.date, "2026-01-02");
  assert.equal(tags.releasedate, "2026-01-02");
  assert.equal(tags.compilation, undefined);
});

function metadataTags(args: string[]) {
  const tags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "-metadata");
    const [key, ...valueParts] = String(args[index + 1]).split("=");
    tags[key] = valueParts.join("=");
  }

  return tags;
}

function providerTrack(overrides: { albumType: string }) {
  return {
    album: "Compilation Album",
    albumId: "album-1",
    albumArtist: "Various Artists",
    albumImageUrl: null,
    albumReleaseDate: "2026-01-02",
    albumReleaseYear: 2026,
    albumTracksTotal: 20,
    albumType: overrides.albumType,
    artists: ["Track Artist"],
    discNumber: 2,
    durationMs: 180000,
    id: "track-1",
    isrc: "USABC2100001",
    name: "Track Name",
    spotifyUrl: "https://open.spotify.com/track/track-1",
    trackNumber: 7
  };
}

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
        maxConcurrentDownloads: 1, opusQuality: 192, mp3FallbackEnabled: true, mp3FallbackQuality: 320
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
