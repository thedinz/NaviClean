import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import type { PrivateSettings } from "../src/server/settings.js";
import { findUnindexedNavidromeMatches, listUnindexedFiles, trashUnindexedFiles } from "../src/server/unindexed.js";

test("unindexed view lists unmatched Navidrome diagnostics and drops matched tracks", () => {
  const testSettings = settings("/music");
  const noApiMatch = track({
    id: "no-api",
    navidromeEnrichment: {
      status: "unmatched",
      code: "no-api-match",
      message: "No Navidrome API record matched this local file."
    }
  });
  const stale = track({
    id: "stale",
    navidromeEnrichment: {
      status: "unmatched",
      code: "possible-stale-scan",
      message: "A fresh Navidrome scan may be needed."
    }
  });
  const matched = track({
    id: "matched",
    navidromeEnrichment: {
      status: "matched",
      code: "matched",
      message: "Matched Navidrome metadata by relative path."
    }
  });

  const view = listUnindexedFiles(testSettings, [matched, noApiMatch, stale]);

  assert.deepEqual(view.tracks.map((candidate) => candidate.id), ["stale", "no-api"]);
  assert.equal(view.total, 2);
  assert.equal(view.counts.noApiMatch, 1);
  assert.equal(view.counts.possibleStaleScan, 1);
});

test("trashing unindexed files recycles only files still in the unindexed view", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-unindexed-"));
  const filePath = path.join(root, "Artist", "Album", "01 - Song.mp3");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");

  try {
    const testSettings = settings(root);
    const unindexed = track({
      id: "unindexed",
      absolutePath: filePath,
      relativePath: "Artist/Album/01 - Song.mp3",
      navidromeEnrichment: {
        status: "unmatched",
        code: "no-api-match",
        message: "No Navidrome API record matched this local file."
      }
    });
    const matched = track({
      id: "matched",
      absolutePath: path.join(root, "Artist", "Album", "02 - Indexed.mp3"),
      relativePath: "Artist/Album/02 - Indexed.mp3",
      navidromeEnrichment: {
        status: "matched",
        code: "matched",
        message: "Matched Navidrome metadata by relative path."
      }
    });

    const result = await trashUnindexedFiles(testSettings, [unindexed, matched], ["unindexed", "matched"]);

    assert.equal(result.trashed, 1);
    assert.deepEqual(result.removedTrackIds, ["unindexed"]);
    assert.deepEqual(result.tracks.map((candidate) => candidate.id), ["matched"]);
    assert.equal(result.unindexed.total, 0);
    assert.ok(result.errors.some((error) => error.includes("matched: file is no longer unindexed")));
    await assert.rejects(fs.access(filePath), /ENOENT/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("Navidrome match probe explains why a searched candidate was not accepted", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    relativePath: "Artist/Artist - Album (2026)/Artist - Album (2026) - 01 - Song.mp3",
    absolutePath: "/music/Artist/Artist - Album (2026)/Artist - Album (2026) - 01 - Song.mp3",
    size: 100,
    navidromeEnrichment: {
      status: "unmatched",
      code: "no-api-match",
      message: "No Navidrome API record matched this local file."
    }
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/search3.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          searchResult3: {
            song: [
              {
                id: "nav-song",
                title: "Song",
                artist: "Artist",
                albumArtist: "Artist",
                album: "Album",
                track: 1,
                discNumber: 1,
                year: 2026,
                duration: 180,
                size: 101,
                path: "Artist/Album/01 Song.mp3",
                isrc: "USABC2100001"
              }
            ]
          }
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.equal(result.query, "Artist Album Song");
    assert.equal(candidate?.acceptedBy, null);
    assert.equal(candidate?.checks.relativePath, "different");
    assert.equal(candidate?.checks.filenameSize, "different");
    assert.equal(candidate?.checks.metadataKey, "different");
    assert.ok(candidate?.rejectedReasons.some((reason) => reason.startsWith("Relative path differs")));
    assert.ok(candidate?.rejectedReasons.some((reason) => reason.startsWith("Metadata key differs")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe reports candidates accepted by relaxed metadata matching", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    album: "High Voltage",
    albumArtist: "AC/DC",
    artist: "AC/DC",
    title: "Live Wire",
    trackNumber: 4,
    duration: 350,
    size: 125213835,
    relativePath: "AC DC/AC DC - High Voltage (1994)/AC DC - High Voltage (1994) - 04 - Live Wire.flac",
    absolutePath: "/music/AC DC/AC DC - High Voltage (1994)/AC DC - High Voltage (1994) - 04 - Live Wire.flac",
    navidromeEnrichment: {
      status: "unmatched",
      code: "no-api-match",
      message: "No Navidrome API record matched this local file."
    }
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/search3.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          searchResult3: {
            song: [
              {
                id: "nav-song",
                title: "Live Wire",
                artist: "AC/DC",
                albumArtist: "AC/DC",
                album: "High Voltage (international version)",
                track: 4,
                discNumber: 1,
                year: 1976,
                duration: 349,
                size: 125213835,
                path: "AC_DC/High Voltage (international version)/01-04 - Live Wire.flac"
              }
            ]
          }
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.equal(candidate?.acceptedBy, "edition-metadata-size");
    assert.ok(candidate?.rejectedReasons[0]?.includes("would now match"));
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
        clientId: "",
        clientSecret: "",
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
      autoScanEnabled: true,
      autoScanTime: "02:00",
      extensions: [".mp3"]
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "track-1",
    absolutePath: "/music/Artist/Album/01 - Song.mp3",
    relativePath: "Artist/Album/01 - Song.mp3",
    extension: ".mp3",
    size: 1,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Song",
    trackNumber: 1,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 1,
    year: 2026,
    duration: 180,
    isrc: null,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    duplicateKey: "",
    qualityScore: 0,
    targetPath: "",
    targetRelativePath: "",
    issues: [],
    ...overrides
  };
}
