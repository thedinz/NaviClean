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
      message: "Organized local file did not match a Navidrome API record."
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

test("Navidrome match probe reports candidates accepted by metadata and size matching", async () => {
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

  const navidromeSong = {
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
  };

  globalThis.fetch = navidromeFetchForSearchAndSongs([navidromeSong], [
    {
      album: {
        id: "album-acdc",
        name: "High Voltage (international version)",
        artist: "AC/DC",
        year: 1976,
        songCount: 1
      },
      song: navidromeSong
    }
  ]);

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.match(result.message, /NaviClean scan/);
    assert.equal(candidate?.acceptedBy, "edition-metadata-size");
    assert.ok(candidate?.rejectedReasons[0]?.includes("would now match"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe accepts exact metadata and size when durations differ", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    album: "Music",
    albumArtist: "311",
    artist: "311",
    title: "Freak Out",
    trackNumber: 2,
    duration: 248,
    size: 4827821,
    relativePath: "311/311 - Music (2001)/311 - Music (2001) - 02 - Freak Out.mp3",
    absolutePath: "/music/311/311 - Music (2001)/311 - Music (2001) - 02 - Freak Out.mp3",
    navidromeEnrichment: {
      status: "unmatched",
      code: "possible-stale-scan",
      message: "Organized local file did not match a Navidrome API record."
    }
  });

  const navidromeSong = {
    id: "nav-song",
    title: "Freak Out",
    artist: "311",
    albumArtist: "311",
    album: "Music",
    track: 2,
    discNumber: 1,
    year: 1993,
    duration: 224,
    size: 4827821,
    path: "311/Music/01-02 - Freak Out.mp3"
  };

  globalThis.fetch = navidromeFetchForSearchAndSongs([navidromeSong], [
    {
      album: {
        id: "album-311",
        name: "Music",
        artist: "311",
        year: 1993,
        songCount: 1
      },
      song: navidromeSong
    }
  ]);

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.match(result.message, /NaviClean scan/);
    assert.equal(candidate?.acceptedBy, "metadata-size-relaxed-duration");
    assert.equal(candidate?.checks.metadataKey, "different");
    assert.ok(candidate?.rejectedReasons[0]?.includes("would now match"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe accepts provider title suffix differences", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    album: "My Jesus",
    albumArtist: "Anne Wilson",
    artist: "Anne Wilson",
    title: "Prelude (Scatter)",
    trackNumber: 1,
    duration: 59,
    size: 3520275,
    isrc: "USUM72202474",
    relativePath: "Anne Wilson/Anne Wilson - My Jesus (2022)/Anne Wilson - My Jesus (2022) - 01 - Prelude (Scatter).mp3",
    absolutePath: "/music/Anne Wilson/Anne Wilson - My Jesus (2022)/Anne Wilson - My Jesus (2022) - 01 - Prelude (Scatter).mp3",
    navidromeEnrichment: {
      status: "unmatched",
      code: "possible-stale-scan",
      message: "Organized local file did not match a Navidrome API record."
    }
  });
  const navidromeSong = {
    id: "nav-song",
    title: "Prelude (Scatter) (PMEDIA)",
    artist: "Anne Wilson",
    albumArtist: "Anne Wilson",
    album: "My Jesus",
    track: 1,
    discNumber: 1,
    year: 2022,
    duration: 58,
    size: 3520275,
    path: "Anne Wilson/My Jesus/01-01 - Prelude (Scatter) (PMEDIA).mp3"
  };

  globalThis.fetch = navidromeFetchForSearchAndSongs([navidromeSong], [
    {
      album: {
        id: "album-anne-wilson",
        name: "My Jesus",
        artist: "Anne Wilson",
        year: 2022,
        songCount: 1
      },
      song: navidromeSong
    }
  ]);

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.match(result.message, /NaviClean scan/);
    assert.equal(candidate?.acceptedBy, "metadata-size-title-suffix");
    assert.equal(candidate?.checks.metadataKey, "different");
    assert.ok(candidate?.rejectedReasons[0]?.includes("provider title suffix"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe accepts leading artist articles and redundant album years", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    album: "Greatest Hits",
    albumArtist: "Beach Boys",
    artist: "The Beach Boys",
    title: "That's Why God Made the Radio",
    trackNumber: 1,
    duration: 200,
    size: 21599650,
    relativePath: "Beach Boys/Beach Boys - Greatest Hits (2012)/Beach Boys - Greatest Hits (2012) - 01 - That's Why God Made the Radio.flac",
    absolutePath: "/music/Beach Boys/Beach Boys - Greatest Hits (2012)/Beach Boys - Greatest Hits (2012) - 01 - That's Why God Made the Radio.flac",
    navidromeEnrichment: {
      status: "unmatched",
      code: "possible-stale-scan",
      message: "Organized local file did not match a Navidrome API record."
    }
  });
  const navidromeSong = {
    id: "nav-song",
    title: "That's Why God Made the Radio",
    artist: "The Beach Boys",
    albumArtist: "The Beach Boys",
    album: "Greatest Hits (2012)",
    track: 1,
    discNumber: 1,
    year: 2012,
    duration: 200,
    size: 21599650,
    path: "The Beach Boys - Beach Boys/Greatest Hits (2012)/01-01 - That's Why God Made the Radio.flac"
  };

  globalThis.fetch = navidromeFetchForSearchAndSongs([navidromeSong], [
    {
      album: {
        id: "album-beach-boys",
        name: "Greatest Hits (2012)",
        artist: "The Beach Boys",
        year: 2012,
        songCount: 1
      },
      song: navidromeSong
    }
  ]);

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.match(result.message, /NaviClean scan/);
    assert.equal(candidate?.acceptedBy, "edition-metadata-size");
    assert.equal(candidate?.checks.metadataKey, "different");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe rejects search-only matches that are ambiguous in the full scan catalog", async () => {
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
    title: "Baby, Please Don't Go",
    trackNumber: 1,
    duration: 292,
    size: 29086348,
    relativePath: "AC-DC/AC-DC - High Voltage (1989)/AC-DC - High Voltage (1989) - 01 - Baby, Please Don't Go.flac",
    absolutePath: "/music/AC-DC/AC-DC - High Voltage (1989)/AC-DC - High Voltage (1989) - 01 - Baby, Please Don't Go.flac",
    navidromeEnrichment: {
      status: "unmatched",
      code: "possible-stale-scan",
      message: "Organized local file did not match a Navidrome API record."
    }
  });
  const searchSong = {
    id: "nav-song-a",
    title: "Baby, Please Don't Go",
    artist: "AC/DC",
    albumArtist: "AC/DC",
    album: "High Voltage (Australian version)",
    track: 1,
    discNumber: 1,
    year: 1975,
    duration: 291,
    size: 29086348,
    path: "AC_DC/High Voltage (Australian version)/01-01 - Baby, Please Don't Go.flac"
  };
  const duplicateSong = {
    ...searchSong,
    id: "nav-song-b",
    album: "High Voltage (1976 remaster)",
    path: "AC_DC/High Voltage (1976 remaster)/01-01 - Baby, Please Don't Go.flac"
  };

  globalThis.fetch = navidromeFetchForSearchAndSongs([searchSong], [
    {
      album: {
        id: "album-acdc-a",
        name: "High Voltage (Australian version)",
        artist: "AC/DC",
        year: 1975,
        songCount: 1
      },
      song: searchSong
    },
    {
      album: {
        id: "album-acdc-b",
        name: "High Voltage (1976 remaster)",
        artist: "AC/DC",
        year: 1976,
        songCount: 1
      },
      song: duplicateSong
    }
  ]);

  try {
    const result = await findUnindexedNavidromeMatches(testSettings, [localTrack], "unindexed");
    const candidate = result.candidates[0];

    assert.doesNotMatch(result.message, /NaviClean scan/);
    assert.equal(candidate?.acceptedBy, null);
    assert.ok(candidate?.rejectedReasons[0]?.includes("multiple records with that same match key"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome match probe does not accept empty metadata-size keys", async () => {
  const originalFetch = globalThis.fetch;
  const testSettings = settings("/music");
  testSettings.navidrome.baseUrl = "http://navidrome.local";
  testSettings.navidrome.username = "admin";
  testSettings.navidrome.password = "password";
  const localTrack = track({
    id: "unindexed",
    album: "Music",
    albumArtist: "311",
    artist: "311",
    title: "",
    trackNumber: null,
    duration: 248,
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
                title: "",
                artist: "311",
                albumArtist: "311",
                album: "Music",
                duration: 224,
                size: 100,
                path: "311/Music/unknown.mp3"
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

    assert.equal(candidate?.acceptedBy, null);
    assert.equal(candidate?.checks.metadataKey, "different");
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

function navidromeFetchForSearchAndSongs(
  searchSongs: Record<string, unknown>[],
  entries: Array<{ album: Record<string, unknown>; song: Record<string, unknown> }>
) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/search3.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          searchResult3: {
            song: searchSongs
          }
        }
      });
    }

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: {
            album: entries.map((entry) => entry.album)
          }
        }
      });
    }

    if (url.pathname.endsWith("/rest/getAlbum.view")) {
      const albumId = url.searchParams.get("id");
      const entry = entries.find((candidate) => candidate.album.id === albumId) ?? entries[0];

      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          album: {
            ...entry.album,
            song: [entry.song]
          }
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };
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
