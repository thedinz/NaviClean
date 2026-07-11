import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fetchNavidromeArtwork, getNavidromeScanStatus, startNavidromeScan } from "../src/server/navidrome.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("album artwork resolves through Navidrome search3 and getCoverArt", async () => {
  const originalFetch = globalThis.fetch;
  const calls: URL[] = [];

  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url);

    if (url.pathname.endsWith("/rest/search3.view")) {
      assert.equal(url.searchParams.get("query"), "Artist Album");
      assert.equal(url.searchParams.get("albumCount"), "20");

      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          searchResult3: {
            album: [
              {
                id: "album-id",
                artist: "Artist",
                name: "Album",
                coverArt: "cover-id",
                year: 2026
              }
            ]
          }
        }
      });
    }

    if (url.pathname.endsWith("/rest/getCoverArt.view")) {
      assert.equal(url.searchParams.get("id"), "cover-id");
      assert.equal(url.searchParams.get("size"), "360");

      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "image/jpeg"
        }
      });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const result = await fetchNavidromeArtwork(
      settings("C:/music"),
      {
        type: "album",
        artist: "Artist",
        album: "Album",
        year: "2026"
      },
      360
    );

    assert.equal(result?.contentType, "image/jpeg");
    assert.deepEqual(result?.data, Buffer.from([1, 2, 3]));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url.searchParams.has("t") && url.searchParams.has("s")));
    assert.ok(calls.every((url) => !url.searchParams.has("p")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome scan status maps getScanStatus response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.pathname, "/rest/getScanStatus.view");
    assert.equal(url.searchParams.get("f"), "json");
    assert.ok(url.searchParams.has("t"));
    assert.ok(url.searchParams.has("s"));
    assert.ok(!url.searchParams.has("p"));

    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        scanStatus: {
          scanning: true,
          count: 42,
          folderCount: 7,
          lastScan: "2026-07-07T12:30:00Z",
          scanType: "quick",
          elapsedTime: 15
        }
      }
    });
  }) as typeof fetch;

  try {
    const result = await getNavidromeScanStatus(settings("/music"));

    assert.deepEqual(result, {
      configured: true,
      running: true,
      count: 42,
      folderCount: 7,
      lastScan: "2026-07-07T12:30:00Z",
      error: null,
      scanType: "quick",
      elapsedSeconds: 15
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome full scan starts through startScan", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.pathname, "/rest/startScan.view");
    assert.equal(url.searchParams.get("fullScan"), "true");
    assert.equal(url.searchParams.get("f"), "json");

    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        scanStatus: {
          scanning: true,
          count: "0",
          folderCount: "0",
          scanType: "full",
          elapsedTime: "0"
        }
      }
    });
  }) as typeof fetch;

  try {
    const result = await startNavidromeScan(settings("/music"), { fullScan: true });

    assert.equal(result.configured, true);
    assert.equal(result.running, true);
    assert.equal(result.scanType, "full");
    assert.equal(result.elapsedSeconds, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Navidrome scan status skips the API when connection settings are missing", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = (async () => {
    called = true;
    throw new Error("Unexpected fetch");
  }) as typeof fetch;

  try {
    const scanSettings = settings("/music");
    scanSettings.navidrome.baseUrl = "";

    const result = await getNavidromeScanStatus(scanSettings);

    assert.equal(called, false);
    assert.deepEqual(result, {
      configured: false,
      running: false,
      count: 0,
      folderCount: 0,
      lastScan: null,
      error: null,
      scanType: null,
      elapsedSeconds: null
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    }
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
      baseUrl: "http://navidrome.local",
      username: "admin",
      password: "secret"
    },
    catalog: {
      spotify: {
        clientId: "",
        clientSecret: "",
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
      libraryPath,
      recycleBinPath: path.join(libraryPath, ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: {
      extensions: [".mp3", ".flac"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}
