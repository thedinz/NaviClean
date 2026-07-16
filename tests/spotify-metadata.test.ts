import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveTrackMetadataFromSpotify } from "../src/server/spotify-metadata.js";
import type { PrivateSettings } from "../src/server/settings.js";
import type { TrackFile } from "../src/shared/types.js";

test("a confirmed Spotify match corrects unambiguous album siblings in the same source folder", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return jsonResponse({ access_token: "metadata-test-token", expires_in: 3600 });
    }

    if (url.pathname === "/v1/tracks/spotify-9") {
      return jsonResponse(spotifyTrack("spotify-9", "Live Slow or Die Fast", 9, true));
    }

    if (url.pathname === "/v1/albums/album-5280") {
      return jsonResponse({
        ...spotifyAlbum(),
        tracks: {
          items: [
            spotifyTrack("spotify-9", "Live Slow or Die Fast", 9, false),
            spotifyTrack("spotify-10", "Set Me Free", 10, false)
          ]
        }
      });
    }

    if (url.pathname === "/v1/tracks") {
      return jsonResponse({
        tracks: [
          spotifyTrack("spotify-9", "Live Slow or Die Fast", 9, false),
          spotifyTrack("spotify-10", "Set Me Free", 10, false)
        ]
      });
    }

    return jsonResponse({ error: `Unexpected request: ${url.pathname}` }, 404);
  };

  try {
    const tracks = [
      localTrack("local-9", "Russ/Unknown source/09 - Live Slow or Die Fast.m4a", "Live Slow or Die Fast", 9),
      localTrack("local-10", "Russ/Unknown source/10 - Set Me Free.m4a", "Set Me Free", 10),
      localTrack("other", "Russ/Another folder/10 - Set Me Free.m4a", "Set Me Free", 10)
    ];
    const result = await resolveTrackMetadataFromSpotify(settings(), tracks, "local-9", "spotify-9");

    assert.equal(result.matchedTracks, 2);
    assert.deepEqual(result.updatedTrackIds, ["local-9", "local-10"]);
    assert.equal(result.tracks[0]?.album, "5280");
    assert.equal(result.tracks[1]?.album, "5280");
    assert.equal(result.tracks[1]?.targetSource, "spotify");
    assert.equal(result.tracks[1]?.isrc, "USABC1300010");
    assert.equal(result.tracks[1]?.targetRelativePath, "Russ/Russ - 5280 (2013)/Russ - 5280 (2013) - 10 - Set Me Free.m4a");
    assert.equal(result.tracks[2]?.album, "Unknown Album");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function spotifyAlbum() {
  return {
    album_type: "album",
    artists: [{ id: "russ", name: "Russ" }],
    external_urls: { spotify: "https://open.spotify.com/album/album-5280" },
    id: "album-5280",
    images: [],
    name: "5280",
    release_date: "2013",
    total_tracks: 12
  };
}

function spotifyTrack(id: string, name: string, trackNumber: number, includeAlbum: boolean) {
  return {
    ...(includeAlbum ? { album: spotifyAlbum() } : {}),
    artists: [{ id: "russ", name: "Russ" }],
    disc_number: 1,
    duration_ms: 180000,
    explicit: false,
    external_ids: { isrc: `USABC13000${trackNumber}` },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    id,
    name,
    track_number: trackNumber
  };
}

function localTrack(id: string, relativePath: string, title: string, trackNumber: number): TrackFile {
  return {
    id,
    absolutePath: path.join("/music", ...relativePath.split("/")),
    relativePath,
    extension: ".m4a",
    size: 1000,
    mtimeMs: 1,
    artist: "Russ",
    albumArtist: "Russ",
    album: "Unknown Album",
    albumType: "Album",
    title,
    trackNumber,
    trackTotal: null,
    discNumber: null,
    discTotal: null,
    year: 2013,
    duration: 180,
    isrc: null,
    bitrate: 256000,
    sampleRate: 44100,
    bitsPerSample: null,
    codec: "AAC",
    container: "M4A",
    lossless: false,
    duplicateKey: `old-${id}`,
    qualityScore: 900,
    targetPath: "",
    targetRelativePath: "",
    issues: ["Missing album"]
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function settings(): PrivateSettings {
  return {
    auth: { enabled: true, username: "admin", passwordHash: "" },
    navidrome: { baseUrl: "", username: "", password: "" },
    catalog: {
      spotify: { clientId: "metadata-client", clientSecret: "metadata-secret", market: "US" },
      providers: { maxConcurrentDownloads: 1, opusQuality: 192, mp3FallbackEnabled: true, mp3FallbackQuality: 320 },
      discovery: { requestsPerMinute: 1000 }
    },
    naming: {
      mode: "standard",
      libraryPath: "/music",
      recycleBinPath: "/music/.naviclean-trash",
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: { autoScanEnabled: true, autoScanTime: "02:00", extensions: [".m4a"] },
    cleanup: { emptyFolderExclusions: [] }
  };
}
