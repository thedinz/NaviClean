import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import { buildOrganizePlan } from "../src/server/organizer.js";
import type { PrivateSettings } from "../src/server/settings.js";
import { closeSpotifyOrganizeStoreForTests, enrichTracksWithSpotifyOrganizeMetadata } from "../src/server/spotify.js";

test("spotify organize enrichment uses Spotify album metadata for target naming", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-spotify-organizer-"));
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({
        access_token: "test-token",
        expires_in: 3600
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/search") {
      searchCalls += 1;
      return jsonResponse({
        tracks: {
          items: [
            {
              album: {
                album_type: "single",
                artists: [{ id: "artist-1", name: "Journey Worship Co." }],
                external_urls: { spotify: "https://open.spotify.com/album/album-1" },
                id: "album-1",
                images: [],
                name: "Come to the Lord",
                release_date: "2021-05-07",
                total_tracks: 1
              },
              artists: [{ id: "artist-1", name: "Journey Worship Co." }],
              disc_number: 1,
              duration_ms: 180000,
              explicit: false,
              external_ids: { isrc: "USABC2100001" },
              external_urls: { spotify: "https://open.spotify.com/track/track-1" },
              id: "track-1",
              name: "Come to the Lord",
              track_number: 1
            }
          ]
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const relativePath =
      "Journey Worship Co/Journey Worship Co. - Come to the Lord (2021)/Journey Worship Co. - Come to the Lord (2021) - 01 - Come to the Lord.mp3";
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "audio");

    const [enriched] = (await enrichTracksWithSpotifyOrganizeMetadata(
      settings(root),
      [
        track({
          absolutePath,
          relativePath,
          album: "Come to the Lord",
          albumArtist: "Journey Worship Co.",
          artist: "Journey Worship Co.",
          title: "Journey Worship Co. - Come to the Lord (2021) - 01 - Come to the Lord",
          trackNumber: null,
          year: 2021
        })
      ],
      { useCache: false }
    )).tracks;

    assert.equal(searchCalls, 1);
    assert.equal(enriched?.targetSource, "spotify");
    assert.equal(enriched?.title, "Come to the Lord");
    assert.equal(enriched?.trackNumber, 1);
    assert.equal(enriched?.isrc, "USABC2100001");

    const plan = await buildOrganizePlan([enriched as TrackFile], settings(root));
    assert.equal(plan.summary.same, 1);
    assert.equal(plan.items[0]?.targetSource, "spotify");
    assert.equal(plan.items[0]?.targetRelativePath, relativePath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("spotify organize enrichment reuses durable cached metadata without a lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-spotify-cache-"));
  const storePath = path.resolve(process.cwd(), ".data", "spotify-organize.sqlite");
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;

  closeSpotifyOrganizeStoreForTests();
  await fs.rm(storePath, { force: true });
  await fs.rm(`${storePath}-journal`, { force: true });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({
        access_token: "test-token",
        expires_in: 3600
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/search") {
      searchCalls += 1;
      return jsonResponse({
        tracks: {
          items: [
            {
              album: {
                album_type: "album",
                artists: [{ id: "artist-cache", name: "Cache Artist" }],
                external_urls: { spotify: "https://open.spotify.com/album/album-cache" },
                id: "album-cache",
                images: [],
                name: "Cache Album",
                release_date: "2025-02-14",
                total_tracks: 10
              },
              artists: [{ id: "artist-cache", name: "Cache Artist" }],
              disc_number: 1,
              duration_ms: 210000,
              explicit: false,
              external_ids: { isrc: "USABC2500002" },
              external_urls: { spotify: "https://open.spotify.com/track/track-cache" },
              id: "track-cache",
              name: "Cache Song",
              track_number: 2
            }
          ]
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const relativePath =
      "Cache Artist/Cache Artist - Cache Album (2025)/Cache Artist - Cache Album (2025) - 02 - Cache Song.mp3";
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "audio");

    const inputTrack = track({
      absolutePath,
      relativePath,
      album: "Cache Album",
      albumArtist: "Cache Artist",
      artist: "Cache Artist",
      title: "Cache Song",
      trackNumber: 2,
      year: 2025
    });
    const first = await enrichTracksWithSpotifyOrganizeMetadata(settings(root), [inputTrack]);

    assert.equal(searchCalls, 1);
    assert.equal(first.tracks[0]?.targetSource, "spotify");

    globalThis.fetch = async () => {
      throw new Error("Spotify should not be called when lookupMissing is false and the cache is fresh.");
    };

    const second = await enrichTracksWithSpotifyOrganizeMetadata(settings(root), [inputTrack], {
      includeSummaryWarning: false,
      lookupMissing: false
    });

    assert.equal(second.tracks[0]?.targetSource, "spotify");
    assert.equal(second.tracks[0]?.title, "Cache Song");
    assert.equal(second.tracks[0]?.isrc, "USABC2500002");
  } finally {
    globalThis.fetch = originalFetch;
    closeSpotifyOrganizeStoreForTests();
    await fs.rm(storePath, { force: true });
    await fs.rm(`${storePath}-journal`, { force: true });
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("spotify organize enrichment keeps same song on a different album local", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-spotify-cross-album-"));
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({
        access_token: "test-token",
        expires_in: 3600
      });
    }

    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/search") {
      searchCalls += 1;
      return jsonResponse({
        tracks: {
          items: [
            {
              album: {
                album_type: "album",
                artists: [{ id: "artist-best", name: "Album Artist" }],
                external_urls: { spotify: "https://open.spotify.com/album/original-album" },
                id: "original-album",
                images: [],
                name: "Original Album",
                release_date: "1997-01-01",
                total_tracks: 12
              },
              artists: [{ id: "artist-best", name: "Album Artist" }],
              disc_number: 1,
              duration_ms: 275000,
              explicit: false,
              external_ids: { isrc: "USABC9700009" },
              external_urls: { spotify: "https://open.spotify.com/track/original-track" },
              id: "original-track",
              name: "Shared Song",
              track_number: 2
            }
          ]
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const relativePath =
      "Album Artist/Album Artist - Best Of (2020)/Album Artist - Best Of (2020) - 09 - Shared Song.mp3";
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "audio");

    const inputTrack = track({
      absolutePath,
      relativePath,
      album: "Best Of",
      albumArtist: "Album Artist",
      artist: "Album Artist",
      title: "Shared Song",
      trackNumber: 9,
      year: 2020,
      duration: 275,
      isrc: "USABC9700009"
    });
    const result = await enrichTracksWithSpotifyOrganizeMetadata(settings(root), [inputTrack], {
      useCache: false
    });

    assert.equal(searchCalls > 0, true);
    assert.equal(result.tracks[0]?.targetSource, undefined);
    assert.equal(result.tracks[0]?.album, "Best Of");
    assert.equal(result.tracks[0]?.trackNumber, 9);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
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

function settings(libraryPath: string): PrivateSettings {
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
      libraryPath,
      recycleBinPath: path.join(libraryPath, ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat:
        "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat:
        "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: {
      extensions: [".mp3"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    }
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "track-1",
    absolutePath: "/music/track.mp3",
    relativePath: "track.mp3",
    extension: ".mp3",
    size: 10,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Track",
    trackNumber: 1,
    trackTotal: 1,
    discNumber: 1,
    discTotal: null,
    year: 2021,
    duration: 180,
    isrc: null,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    duplicateKey: "",
    qualityScore: 1,
    targetPath: "",
    targetRelativePath: "",
    issues: [],
    ...overrides
  };
}
