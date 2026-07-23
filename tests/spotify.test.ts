import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { providerMetadataArgsForSpotifyTrack } from "../src/server/providers.js";
import {
  buildSpotifyDownloadPlan,
  getSpotifyAlbumDetail,
  searchSpotifyTrackMetadata
} from "../src/server/spotify.js";
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

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/tracks/track-1") {
      trackDetailCalls += 1;
      assert.equal(url.searchParams.has("ids"), false);
      return jsonResponse({
        artists: [{ id: "artist-1", name: "Album Artist" }],
        disc_number: 1,
        duration_ms: 180000,
        explicit: false,
        external_ids: { isrc: "usabc2100001" },
        external_urls: { spotify: "https://open.spotify.com/track/track-1" },
        id: "track-1",
        name: "Track Name",
        track_number: 1
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const album = await getSpotifyAlbumDetail(settings(), [], "album-1", {
      hydrateTrackDetails: true
    });

    assert.equal(trackDetailCalls, 1);
    assert.equal(album.tracks[0]?.isrc, "USABC2100001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify album detail loads every paginated album track without bulk hydration", async () => {
  const originalFetch = globalThis.fetch;
  let trackDetailCalls = 0;
  const tracks = Array.from({ length: 85 }, (_, index) => spotifyTrack(index + 1));

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({
        access_token: "test-token",
        expires_in: 3600
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/albums/album-large") {
      return jsonResponse({
        album_type: "album",
        artists: [{ id: "artist-1", name: "Album Artist" }],
        external_urls: { spotify: "https://open.spotify.com/album/album-large" },
        id: "album-large",
        images: [],
        name: "Large Album",
        release_date: "2026-01-02",
        total_tracks: 85,
        tracks: {
          items: tracks.slice(0, 50),
          next: "https://api.spotify.com/v1/albums/album-large/tracks?offset=50&limit=50"
        }
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/albums/album-large/tracks") {
      assert.equal(url.searchParams.get("offset"), "50");
      return jsonResponse({
        items: tracks.slice(50),
        next: null
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname.startsWith("/v1/tracks")) {
      trackDetailCalls += 1;
      return jsonResponse({ error: "album loading should not hydrate track details" }, 500);
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const album = await getSpotifyAlbumDetail(settings(), [], "album-large");

    assert.equal(album.totalTracks, 85);
    assert.equal(album.tracks.length, 85);
    assert.equal(trackDetailCalls, 0);
    assert.equal(album.tracks[84]?.id, "track-85");
    assert.equal(album.tracks[84]?.isrc, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify track search transparently paginates beyond the new limit of ten", async () => {
  const originalFetch = globalThis.fetch;
  const searchPages: string[] = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({ access_token: "search-test-token", expires_in: 3600 });
    }

    if (url.pathname === "/v1/search") {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      searchPages.push(`${limit}:${offset}`);
      return jsonResponse({
        tracks: {
          items: Array.from({ length: limit }, (_, index) =>
            spotifySearchTrack(offset + index + 1)
          )
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const result = await searchSpotifyTrackMetadata(settings(), "Album Artist Track");

    assert.equal(result.matches.length, 12);
    assert.deepEqual(searchPages, ["10:0", "2:10"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify download plans hydrate only selected tracks and reuse cached details", async () => {
  const originalFetch = globalThis.fetch;
  let trackDetailCalls = 0;
  const tracks = Array.from({ length: 3 }, (_, index) => spotifyTrack(index + 201));

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({ access_token: "plan-test-token", expires_in: 3600 });
    }

    if (url.pathname === "/v1/albums/album-plan") {
      return jsonResponse({
        album_type: "album",
        artists: [{ id: "artist-plan", name: "Plan Artist" }],
        external_urls: { spotify: "https://open.spotify.com/album/album-plan" },
        id: "album-plan",
        images: [],
        name: "Plan Album",
        release_date: "2026-07-23",
        total_tracks: tracks.length,
        tracks: { items: tracks }
      });
    }

    if (url.pathname === "/v1/tracks/track-202") {
      trackDetailCalls += 1;
      return jsonResponse({
        ...tracks[1],
        external_ids: { isrc: "USABC2600202" }
      });
    }

    return jsonResponse({ error: `unexpected request: ${url.pathname}` }, 404);
  };

  try {
    const first = await buildSpotifyDownloadPlan(settings(), [], "album-plan", ["track-202"]);
    const second = await buildSpotifyDownloadPlan(settings(), [], "album-plan", ["track-202"]);

    assert.equal(first.selectedTracks.length, 1);
    assert.equal(first.selectedTracks[0]?.isrc, "USABC2600202");
    assert.equal(first.album.tracks[0]?.isrc, null);
    assert.equal(first.album.tracks[1]?.isrc, "USABC2600202");
    assert.equal(second.selectedTracks[0]?.isrc, "USABC2600202");
    assert.equal(trackDetailCalls, 1);
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
  assert.equal(tags["trackkeep:track_id"], "track-1");
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

function spotifyTrack(number: number) {
  return {
    artists: [{ id: "artist-1", name: "Album Artist" }],
    disc_number: number > 50 ? 2 : 1,
    duration_ms: 180000,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/track-${number}` },
    id: `track-${number}`,
    name: `Track ${number}`,
    track_number: number > 50 ? number - 50 : number
  };
}

function spotifySearchTrack(number: number) {
  return {
    ...spotifyTrack(number + 300),
    album: {
      album_type: "album",
      artists: [{ id: "artist-search", name: "Search Artist" }],
      external_urls: { spotify: "https://open.spotify.com/album/album-search" },
      id: `album-search-${number}`,
      images: [],
      name: `Search Album ${number}`,
      release_date: "2026",
      total_tracks: 12
    }
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
