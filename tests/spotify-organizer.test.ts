import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import { buildOrganizePlan } from "../src/server/organizer.js";
import type { PrivateSettings } from "../src/server/settings.js";
import { enrichTracksWithSpotifyOrganizeMetadata } from "../src/server/spotify.js";

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
