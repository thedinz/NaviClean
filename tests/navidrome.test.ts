import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fetchNavidromeArtwork } from "../src/server/navidrome.js";
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
      standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: {
      extensions: [".mp3", ".flac"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    }
  };
}
