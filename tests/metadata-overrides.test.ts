import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PrivateSettings } from "../src/server/settings.js";

test("user metadata decisions survive later scans whether Navidrome matches or not", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-metadata-override-"));
  const dataDir = path.join(root, "data");
  process.env.NAVICLEAN_DATA_DIR = dataDir;
  const { scanLibrary } = await import("../src/server/scanner.js");
  const { saveMetadataOverridesForTracks } = await import("../src/server/metadata-overrides.js");
  const { listUnindexedFiles } = await import("../src/server/unindexed.js");
  const trustedRelativePath = "Artist/Artist - Real Album (2020)/Artist - Real Album (2020) - 01 - Track.mp3";
  const spotifyRelativePath = "[Unknown Artist]/[Unknown Artist] - [Unknown Album] (2018)/[Unknown Artist] - [Unknown Album] (2018) - 01 - The Flute Song.mp3";
  const unmatchedSpotifyRelativePath = "[Unknown Artist]/[Unknown Artist] - [Unknown Album] (1994)/[Unknown Artist] - [Unknown Album] (1994) - 01 - N.Y. State of Mind.mp3";
  const originalFetch = globalThis.fetch;

  try {
    const libraryPath = path.join(root, "music");
    const trustedFilePath = path.join(libraryPath, ...trustedRelativePath.split("/"));
    const spotifyFilePath = path.join(libraryPath, ...spotifyRelativePath.split("/"));
    const unmatchedSpotifyFilePath = path.join(libraryPath, ...unmatchedSpotifyRelativePath.split("/"));
    await fs.mkdir(path.dirname(trustedFilePath), { recursive: true });
    await fs.mkdir(path.dirname(spotifyFilePath), { recursive: true });
    await fs.mkdir(path.dirname(unmatchedSpotifyFilePath), { recursive: true });
    await fs.writeFile(trustedFilePath, "trusted audio");
    await fs.writeFile(spotifyFilePath, "spotify audio");
    await fs.writeFile(unmatchedSpotifyFilePath, "unmatched spotify audio");
    const scanSettings = settings(libraryPath);
    const first = await scanLibrary(scanSettings);
    const trustedTrack = first.tracks.find((track) => track.relativePath === trustedRelativePath);
    const unresolvedSpotifyTrack = first.tracks.find((track) => track.relativePath === spotifyRelativePath);
    const unmatchedSpotifyTrack = first.tracks.find((track) => track.relativePath === unmatchedSpotifyRelativePath);

    assert.equal(trustedTrack?.metadataConfidence, "path-suggestion");
    assert.ok(trustedTrack);
    assert.ok(unresolvedSpotifyTrack);
    assert.ok(unmatchedSpotifyTrack);
    await saveMetadataOverridesForTracks([trustedTrack], "trusted-path");
    await saveMetadataOverridesForTracks(
      [
        {
          ...unresolvedSpotifyTrack,
          artist: "Russ",
          albumArtist: "Russ",
          album: "ZOO",
          albumType: "Album",
          title: "The Flute Song",
          trackNumber: 1,
          trackTotal: 14,
          discNumber: 1,
          discTotal: 1,
          year: 2018,
          isrc: "USQX91802103"
        },
        {
          ...unmatchedSpotifyTrack,
          artist: "Nas",
          albumArtist: "Nas",
          album: "Illmatic",
          albumType: "Album",
          title: "N.Y. State of Mind",
          trackNumber: 2,
          trackTotal: 10,
          discNumber: 1,
          discTotal: 1,
          year: 1994,
          isrc: "USSM10017344"
        }
      ],
      "spotify"
    );

    globalThis.fetch = navidromeFetchForSongs([
      {
        album: { id: "trusted-album", name: "Wrong Trusted Album", artist: "Navidrome Artist", year: 1999, songCount: 1 },
        song: {
          id: "trusted-song",
          title: "Wrong Trusted Title",
          artist: "Navidrome Artist",
          albumArtist: "Navidrome Artist",
          album: "Wrong Trusted Album",
          track: 9,
          year: 1999,
          size: Buffer.byteLength("trusted audio"),
          path: trustedRelativePath,
          suffix: "mp3"
        }
      },
      {
        album: { id: "spotify-album", name: "Navidrome Album", artist: "Navidrome Artist", year: 2001, songCount: 1 },
        song: {
          id: "spotify-song",
          title: "Navidrome Title",
          artist: "Navidrome Artist",
          albumArtist: "Navidrome Artist",
          album: "Navidrome Album",
          track: 7,
          year: 2001,
          size: Buffer.byteLength("spotify audio"),
          path: spotifyRelativePath,
          suffix: "mp3"
        }
      }
    ]);
    scanSettings.navidrome = { baseUrl: "http://navidrome.local", username: "admin", password: "password" };

    const second = await scanLibrary(scanSettings);
    const rescannedTrustedTrack = second.tracks.find((track) => track.relativePath === trustedRelativePath);
    const rescannedSpotifyTrack = second.tracks.find((track) => track.relativePath === spotifyRelativePath);
    const rescannedUnmatchedSpotifyTrack = second.tracks.find((track) => track.relativePath === unmatchedSpotifyRelativePath);

    assert.equal(rescannedTrustedTrack?.metadataConfidence, "trusted-path");
    assert.equal(rescannedTrustedTrack?.album, "Real Album");
    assert.equal(rescannedTrustedTrack?.navidromeEnrichment?.code, "matched");
    assert.equal(rescannedSpotifyTrack?.metadataConfidence, "spotify");
    assert.equal(rescannedSpotifyTrack?.targetSource, "spotify");
    assert.equal(rescannedSpotifyTrack?.artist, "Russ");
    assert.equal(rescannedSpotifyTrack?.album, "ZOO");
    assert.equal(rescannedSpotifyTrack?.title, "The Flute Song");
    assert.equal(rescannedSpotifyTrack?.trackNumber, 1);
    assert.equal(rescannedSpotifyTrack?.year, 2018);
    assert.equal(rescannedSpotifyTrack?.navidromeEnrichment?.code, "matched");
    assert.equal(rescannedUnmatchedSpotifyTrack?.metadataConfidence, "spotify");
    assert.equal(rescannedUnmatchedSpotifyTrack?.artist, "Nas");
    assert.equal(rescannedUnmatchedSpotifyTrack?.album, "Illmatic");
    assert.equal(rescannedUnmatchedSpotifyTrack?.navidromeEnrichment?.status, "skipped");
    assert.equal(rescannedUnmatchedSpotifyTrack?.navidromeEnrichment?.code, "spotify-confirmed");
    assert.equal(listUnindexedFiles(scanSettings, second.tracks).total, 0);
    assert.ok(second.warnings.some((warning) => warning.includes("retained user-confirmed Spotify metadata")));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.NAVICLEAN_DATA_DIR;
    await fs.rm(root, { force: true, recursive: true });
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function navidromeFetchForSongs(entries: Array<{ album: Record<string, unknown>; song: Record<string, unknown> }>) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: { album: entries.map((entry) => entry.album) }
        }
      });
    }

    if (url.pathname.endsWith("/rest/getAlbum.view")) {
      const albumId = url.searchParams.get("id");
      const entry = entries.find((candidate) => candidate.album.id === albumId) ?? entries[0];
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          album: { ...entry.album, song: [entry.song] }
        }
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  };
}

function settings(libraryPath: string): PrivateSettings {
  return {
    auth: { enabled: true, username: "admin", passwordHash: "" },
    navidrome: { baseUrl: "", username: "", password: "" },
    catalog: {
      spotify: { clientId: "", clientSecret: "", market: "US" },
      providers: { maxConcurrentDownloads: 1, opusQuality: 192, mp3FallbackEnabled: true, mp3FallbackQuality: 320 },
      discovery: { requestsPerMinute: 40 }
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
    scan: { autoScanEnabled: true, autoScanTime: "02:00", extensions: [".mp3"] },
    cleanup: { emptyFolderExclusions: [] }
  };
}
