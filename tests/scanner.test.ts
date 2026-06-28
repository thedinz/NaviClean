import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanLibrary } from "../src/server/scanner.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("scanner infers the release year when the parent artist folder stripped trailing punctuation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-"));

  try {
    const relativePath =
      "Journey Worship Co/Journey Worship Co. - Come to the Lord (2021)/Journey Worship Co. - Come to the Lord (2021) - 01 - Come to the Lord.mp3";
    const filePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const result = await scanLibrary(settings(root));
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.albumArtist, "Journey Worship Co.");
    assert.equal(track?.album, "Come to the Lord");
    assert.equal(track?.title, "Come to the Lord");
    assert.equal(track?.trackNumber, 1);
    assert.equal(track?.year, 2021);
    assert.equal(track?.targetRelativePath, relativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner does not block on uncached Spotify lookups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-spotify-"));
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Scan should not call Spotify for uncached organize metadata.");
  };

  try {
    const relativePath =
      "Compilation Artist/Compilation Artist - Best Of (2020)/Compilation Artist - Best Of (2020) - 01 - Known Song.mp3";
    const filePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const scanSettings = settings(root);
    scanSettings.catalog.spotify.clientId = "client-id";
    scanSettings.catalog.spotify.clientSecret = "client-secret";
    const result = await scanLibrary(scanSettings);

    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0]?.targetSource, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner uses Navidrome indexed metadata for target naming", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath = "loose/random-file.mp3";

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: {
            album: [
              {
                id: "album-1",
                name: "Best Of",
                artist: "Album Artist",
                year: 2020,
                songCount: 1
              }
            ]
          }
        }
      });
    }

    if (url.pathname.endsWith("/rest/getAlbum.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          album: {
            id: "album-1",
            name: "Best Of",
            artist: "Album Artist",
            year: 2020,
            songCount: 1,
            song: [
              {
                id: "song-1",
                title: "Shared Song",
                artist: "Album Artist",
                albumArtist: "Album Artist",
                album: "Best Of",
                track: 9,
                year: 2020,
                duration: 275,
                path: sourceRelativePath,
                suffix: "mp3"
              }
            ]
          }
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.albumArtist, "Album Artist");
    assert.equal(track?.album, "Best Of");
    assert.equal(track?.title, "Shared Song");
    assert.equal(track?.trackNumber, 9);
    assert.equal(
      track?.targetRelativePath,
      "Album Artist/Album Artist - Best Of (2020)/Album Artist - Best Of (2020) - 09 - Shared Song.mp3"
    );
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
      extensions: [".mp3"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    }
  };
}
