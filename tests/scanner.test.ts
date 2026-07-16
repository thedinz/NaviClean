import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hasSpotifyBuIdentityTags, scanLibrary } from "../src/server/scanner.js";
import { buildOrganizePlan } from "../src/server/organizer.js";
import { trustPathMetadataForFolder } from "../src/server/metadata-review.js";
import type { PrivateSettings } from "../src/server/settings.js";
import { spotifyBuMetadataTagsForSpotifyTrack } from "../src/server/spotifybu.js";

test("scanner recognizes SpotifyBU track identity tags", () => {
  assert.equal(
    hasSpotifyBuIdentityTags({
      native: {
        "ID3v2.4": [{ id: "TXXX:spotifybu:track_id", value: "spotify-track-id" }]
      }
    }),
    true
  );

  assert.equal(
    hasSpotifyBuIdentityTags({
      native: {
        iTunes: [{ id: "----:com.apple.iTunes:spotifybu:track_uri", value: "spotify:track:123" }]
      }
    }),
    true
  );

  assert.equal(
    hasSpotifyBuIdentityTags({
      common: {
        spotifybu_track_uri: "spotify:track:456"
      } as Record<string, unknown>
    }),
    true
  );
});

test("scanner recognizes SpotifyBU v1 identity aliases", () => {
  for (const key of ["album_id", "identity_version", "isrc", "track_id", "track_uri"]) {
    assert.equal(
      hasSpotifyBuIdentityTags({
        common: {
          [`spotifybu_${key}`]: key === "identity_version" ? "1" : `value-${key}`
        } as Record<string, unknown>
      }),
      true
    );

    assert.equal(
      hasSpotifyBuIdentityTags({
        native: {
          iTunes: [{ id: `----:com.apple.iTunes:spotifybu:${key}`, value: key === "identity_version" ? "1" : `value-${key}` }]
        }
      }),
      true
    );
  }
});

test("SpotifyBU metadata helper emits scanner-recognized identity tags", () => {
  const tags = spotifyBuMetadataTagsForSpotifyTrack({
    albumId: "spotify-album-id",
    isrc: "usabc2100001",
    trackId: "spotify-track-id"
  });

  assert.deepEqual(
    tags.map((tag) => tag.key),
    [
      "spotifybu:track_id",
      "spotifybu:track_uri",
      "spotifybu:album_id",
      "spotifybu:isrc",
      "spotifybu:identity_version"
    ]
  );
  assert.deepEqual(
    tags.map((tag) => tag.value),
    [
      "spotify-track-id",
      "spotify:track:spotify-track-id",
      "spotify-album-id",
      "USABC2100001",
      "1"
    ]
  );
  assert.equal(
    hasSpotifyBuIdentityTags({
      common: Object.fromEntries(tags.map((tag) => [tag.key, tag.value]))
    }),
    true
  );
});

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

test("scanner repairs UTF-16 mojibake text in inferred titles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-mojibake-"));
  const corruptedTitle =
    "y\u59fe\u6f00\u7500\u2700\u7200\u6500 \u4200\u6500\u6100\u7500\u7400\u6900\u6600\u7500\u6c00 \u2800\u6500\u6400\u6900\u7400\u2900";
  const sourceRelativePath =
    `James Blunt/James Blunt - You're Beautiful (2005)/James Blunt - You're Beautiful (2005) - 01 - ${corruptedTitle}.mp3`;
  const targetRelativePath =
    "James Blunt/James Blunt - You're Beautiful (2005)/James Blunt - You're Beautiful (2005) - 01 - You're Beautiful (edit).mp3";

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const result = await scanLibrary(settings(root));
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.title, "You're Beautiful (edit)");
    assert.ok(track?.issues.includes("Repaired corrupted text encoding in title"));
    assert.equal(track?.targetRelativePath, targetRelativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner unwraps unknown folders around a nested standard filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-unknown-wrapper-"));
  const sourceRelativePath =
    "Unknown Artist]/[Unknown Artist] - [Unknown Album] (2019)/[Unknown Artist] - [Unknown Album] (2019) - 01 - Russ - BEST ON EARTH (feat. BIA) [Bonus] (2019) - 01 - BEST ON EARTH (feat. BIA) - Bonus.m4a";
  const targetRelativePath =
    "Russ/Russ - BEST ON EARTH (feat. BIA) [Bonus] (2019)/Russ - BEST ON EARTH (feat. BIA) [Bonus] (2019) - 01 - BEST ON EARTH (feat. BIA) - Bonus.m4a";

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const scanSettings = settings(root);
    scanSettings.scan.extensions.push(".m4a");
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.artist, "Russ");
    assert.equal(track?.albumArtist, "Russ");
    assert.equal(track?.album, "BEST ON EARTH (feat. BIA) [Bonus]");
    assert.equal(track?.title, "BEST ON EARTH (feat. BIA) - Bonus");
    assert.equal(track?.trackNumber, 1);
    assert.equal(track?.year, 2019);
    assert.equal(track?.issues.includes("Missing artist"), false);
    assert.equal(track?.issues.includes("Missing album"), false);
    assert.equal(track?.targetRelativePath, targetRelativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner ignores unknown placeholder tags when a structured path exposes real metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-unknown-tags-"));
  const sourceRelativePath =
    "[Unknown Artist]/[Unknown Artist] - [Unknown Album] (2018)/[Unknown Artist] - [Unknown Album] (2018) - 01 - Russ - ZOO (2018) - 01 - The Flute Song.mp3";
  const targetRelativePath =
    "Russ/Russ - ZOO (2018)/Russ - ZOO (2018) - 01 - The Flute Song.mp3";

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      id3TaggedMp3({
        album: "[Unknown Album]",
        albumArtist: "[Unknown Artist]",
        artist: "[Unknown Artist]",
        title: "[Unknown Artist] - [Unknown Album] (2018) - 01 - Russ - ZOO (2018) - 01 - The Flute Song",
        track: "1",
        year: "2018"
      })
    );

    const result = await scanLibrary(settings(root));
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.artist, "Russ");
    assert.equal(track?.albumArtist, "Russ");
    assert.equal(track?.album, "ZOO");
    assert.equal(track?.title, "The Flute Song");
    assert.equal(track?.trackNumber, 1);
    assert.equal(track?.year, 2018);
    assert.equal(track?.issues.includes("Missing artist"), false);
    assert.equal(track?.issues.includes("Missing album"), false);
    assert.ok(track?.issues.includes("Embedded metadata used unknown placeholders; used structured path metadata"));
    assert.equal(track?.targetRelativePath, targetRelativePath);
    assert.equal(track?.metadataConfidence, "path-suggestion");
    const reviewPlan = await buildOrganizePlan(result.tracks, settings(root));
    assert.equal(reviewPlan.items[0]?.status, "metadata-review");
    assert.equal(reviewPlan.summary.metadataReview, 1);

    const trusted = trustPathMetadataForFolder(settings(root), result.tracks, String(track?.id));
    assert.equal(trusted.trustedTracks, 1);
    assert.equal(trusted.tracks[0]?.metadataConfidence, "trusted-path");
    assert.equal((await buildOrganizePlan(trusted.tracks, settings(root))).items[0]?.status, "ready");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner does not promote an ambiguous numeric folder name to trusted album metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-untrusted-numeric-album-"));
  const relativePath =
    "Russ/Russ - 5280 (2013)/Russ - 5280 (2013) - 09 - Live Slow or Die Fast.m4a";

  try {
    const filePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");
    const scanSettings = settings(root);
    scanSettings.scan.extensions.push(".m4a");

    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(track?.artist, "Russ");
    assert.equal(track?.album, "Unknown Album");
    assert.equal(track?.trackNumber, 9);
    assert.equal(track?.year, 2013);
    assert.equal(
      track?.targetRelativePath,
      "Russ/Russ - Unknown Album (2013)/Russ - Unknown Album (2013) - 09 - Live Slow or Die Fast.m4a"
    );
    assert.equal(track?.metadataConfidence, "path-suggestion");
    assert.equal((await buildOrganizePlan(result.tracks, scanSettings)).items[0]?.status, "metadata-review");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner keeps structured path metadata when embedded tags point at a different release version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-path-conflict-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "for KING & COUNTRY/for KING & COUNTRY - Burn The Ships (Deluxe Edition - Remixes & Collaborations) (2021)/for KING & COUNTRY - Burn The Ships (Deluxe Edition - Remixes & Collaborations) (2021) - 17 - God Only Knows (Timbaland Remix).mp3";
  const contents = id3TaggedMp3({
    album: "Burn the Ships",
    albumArtist: "for KING & COUNTRY",
    artist: "for KING & COUNTRY",
    title: "God Only Knows",
    track: "3",
    year: "2018"
  });

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-burn-the-ships",
        name: "Burn the Ships",
        artist: "for KING & COUNTRY",
        year: 2018,
        songCount: 1
      },
      song: {
        id: "song-god-only-knows",
        title: "God Only Knows",
        artist: "for KING & COUNTRY",
        albumArtist: "for KING & COUNTRY",
        album: "Burn the Ships",
        track: 3,
        discNumber: 1,
        year: 2018,
        size: contents.length,
        path: "for KING & COUNTRY/for KING & COUNTRY - Burn the Ships (2018)/for KING & COUNTRY - Burn the Ships (2018) - 03 - God Only Knows.mp3",
        suffix: "mp3"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];
    const plan = await buildOrganizePlan(result.tracks, scanSettings);
    const item = plan.items[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, undefined);
    assert.equal(track?.artist, "for KING & COUNTRY");
    assert.equal(track?.album, "Burn The Ships (Deluxe Edition - Remixes & Collaborations)");
    assert.equal(track?.title, "God Only Knows (Timbaland Remix)");
    assert.equal(track?.trackNumber, 17);
    assert.equal(track?.year, 2021);
    assert.equal(track?.navidromeEnrichment?.code, "possible-stale-scan");
    assert.ok(track?.issues.includes("Embedded metadata conflicted with structured path; used structured path metadata"));
    assert.equal(item?.status, "metadata-review");
    assert.equal(item?.targetSource, "naviclean");
    assert.equal(item?.targetRelativePath, sourceRelativePath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner does not repair legitimate non-Latin titles as mojibake", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-unicode-title-"));
  const sourceRelativePath =
    "Akiko/Akiko - Unicode Album (2024)/Akiko - Unicode Album (2024) - 01 - 美しい曲.mp3";

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");

    const result = await scanLibrary(settings(root));
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.title, "美しい曲");
    assert.equal(track?.issues.some((issue) => issue.includes("corrupted text encoding")), false);
    assert.equal(track?.targetRelativePath, sourceRelativePath);
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

test("scanner matches Navidrome metadata by exact metadata and size", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-relaxed-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath = "311/311 - 311 (1995)/311 - 311 (1995) - 08 - Purpose.mp3";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-311",
        name: "311",
        artist: "311",
        year: 1995,
        songCount: 1
      },
      song: {
        id: "song-purpose",
        title: "Purpose",
        artist: "311",
        albumArtist: "311",
        album: "311",
        track: 8,
        discNumber: 1,
        year: 1995,
        duration: 164,
        size: Buffer.byteLength(contents),
        path: "311/311/01-08 - Purpose.mp3",
        suffix: "mp3"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-relaxed-duration");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata by exact size when parsed durations disagree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-duration-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "311/311 - Music (2001)/311 - Music (2001) - 02 - Freak Out.wav";
  const contents = wavSilence(30);

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-311-music",
        name: "Music",
        artist: "311",
        year: 1993,
        songCount: 1
      },
      song: {
        id: "song-freak-out",
        title: "Freak Out",
        artist: "311",
        albumArtist: "311",
        album: "Music",
        track: 2,
        discNumber: 1,
        year: 1993,
        duration: 54,
        size: contents.length,
        path: "311/Music/01-02 - Freak Out.wav",
        suffix: "wav"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".wav"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.duration, 54);
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-relaxed-duration");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when only the release track number differs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-track-slot-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Cage the Elephant/Cage the Elephant - Ain't No Rest For The Wicked (2008)/Cage the Elephant - Ain't No Rest For The Wicked (2008) - 01 - Ain't No Rest for the Wicked.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-cage",
        name: "Ain't No Rest For The Wicked",
        artist: "Cage the Elephant",
        year: 2008,
        songCount: 3
      },
      song: {
        id: "song-wicked",
        title: "Ain't No Rest for the Wicked",
        artist: "Cage the Elephant",
        albumArtist: "Cage the Elephant",
        album: "Ain't No Rest For The Wicked",
        track: 3,
        discNumber: 1,
        year: 2008,
        duration: 175,
        size: Buffer.byteLength(contents),
        path: "Cage the Elephant/Ain't No Rest For The Wicked/01-03 - Ain't No Rest for the Wicked.flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.trackNumber, 1);
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-track-agnostic");
    assert.equal(track?.targetRelativePath, sourceRelativePath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when local album artist is wrong", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-artist-mismatch-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Leonard Cohen/Leonard Cohen - Live at Radio City (2007)/Leonard Cohen - Live at Radio City (2007) - 02-07 - Lie in Our Graves.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-live-radio-city",
        name: "Live at Radio City",
        artist: "Dave Matthews",
        year: 2007,
        songCount: 25
      },
      song: {
        id: "song-lie-in-our-graves",
        title: "Lie in Our Graves",
        artist: "Dave Matthews",
        albumArtist: "Dave Matthews",
        album: "Live at Radio City",
        track: 7,
        discNumber: 2,
        year: 2007,
        duration: 395,
        size: Buffer.byteLength(contents),
        path: "Dave Matthews • Leonard Cohen/Live at Radio City/02-07 - Lie in Our Graves.flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.albumArtist, "Dave Matthews");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-artist-agnostic");
    assert.equal(
      track?.targetRelativePath,
      "Dave Matthews/Dave Matthews - Live at Radio City (2007)/Dave Matthews - Live at Radio City (2007) - 02-07 - Lie in Our Graves.flac"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner preserves a Latin artist alias from paired Navidrome artist folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-latin-alias-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Junya Nakano/Junya Nakano - Unreleased Tracks 1999 vol.1+2 (2017)/Junya Nakano - Unreleased Tracks 1999 vol.1+2 (2017) - 16 - M16 - Dark night - 19990223.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-unreleased",
        name: "Unreleased Tracks 1999 vol.1+2",
        artist: "\u4ef2\u91ce\u9806\u4e5f",
        year: 2017,
        songCount: 32
      },
      song: {
        id: "song-dark-night",
        title: "M16 - Dark night - 19990223",
        artist: "\u4ef2\u91ce\u9806\u4e5f",
        albumArtist: "\u4ef2\u91ce\u9806\u4e5f",
        album: "Unreleased Tracks 1999 vol.1+2",
        track: 16,
        discNumber: 1,
        year: 2017,
        duration: 188,
        size: Buffer.byteLength(contents),
        path: "\u4ef2\u91ce\u9806\u4e5f \u2022 Junya Nakano/Unreleased Tracks 1999 vol.1+2/01-16 - M16 - Dark night - 19990223.flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.artist, "Junya Nakano");
    assert.equal(track?.albumArtist, "Junya Nakano");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-artist-agnostic");
    assert.equal(track?.targetRelativePath, sourceRelativePath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when only a provider title suffix differs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-title-suffix-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Anne Wilson/Anne Wilson - My Jesus (2022)/Anne Wilson - My Jesus (2022) - 01 - Prelude (Scatter).mp3";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-anne-wilson",
        name: "My Jesus",
        artist: "Anne Wilson",
        year: 2022,
        songCount: 1
      },
      song: {
        id: "song-prelude",
        title: "Prelude (Scatter) (PMEDIA)",
        artist: "Anne Wilson",
        albumArtist: "Anne Wilson",
        album: "My Jesus",
        track: 1,
        discNumber: 1,
        year: 2022,
        duration: 58,
        size: Buffer.byteLength(contents),
        path: "Anne Wilson/My Jesus/01-01 - Prelude (Scatter) (PMEDIA).mp3",
        suffix: "mp3"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.title, "Prelude (Scatter)");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-title-suffix");
    assert.equal(
      track?.targetRelativePath,
      "Anne Wilson/Anne Wilson - My Jesus (2022)/Anne Wilson - My Jesus (2022) - 01 - Prelude (Scatter).mp3"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when title has junk artist disambiguation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-title-disambiguation-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Chris Knight/Chris Knight - A Pretty Good Guy (2001)/Chris Knight - A Pretty Good Guy (2001) - 01 - Becky's Bible.mp3";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-chris-knight",
        name: "A Pretty Good Guy",
        artist: "Chris Knight",
        year: 2001,
        songCount: 1
      },
      song: {
        id: "song-beckys-bible",
        title: "Becky's Bible (Chris Knight - Country Music Singer, b-1960, -)",
        artist: "Chris Knight",
        albumArtist: "Chris Knight",
        album: "A Pretty Good Guy",
        track: 1,
        discNumber: 1,
        year: 2001,
        duration: 266,
        size: Buffer.byteLength(contents),
        path: "Chris Knight/A Pretty Good Guy/01-01 - Becky's Bible (Chris Knight - Country Music Singer, b-1960, -).mp3",
        suffix: "mp3"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.title, "Becky's Bible");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-title-suffix");
    assert.equal(track?.targetRelativePath, sourceRelativePath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when title repeats in a parenthetical suffix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-title-repeat-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "The Yardbirds/The Yardbirds - Eric Clapton & Friends - From Yardbirds to Bluesbreakers (1992)/The Yardbirds - Eric Clapton & Friends - From Yardbirds to Bluesbreakers (1992) - 01 - I Wish You Would.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-yardbirds",
        name: "Eric Clapton & Friends: From Yardbirds to Bluesbreakers",
        artist: "The Yardbirds",
        year: 1992,
        songCount: 1
      },
      song: {
        id: "song-i-wish-you-would",
        title: "I Wish You Would (I Wish You Would)",
        artist: "The Yardbirds",
        albumArtist: "The Yardbirds",
        album: "Eric Clapton & Friends: From Yardbirds to Bluesbreakers",
        track: 1,
        discNumber: 1,
        year: 1992,
        duration: 135,
        size: Buffer.byteLength(contents),
        path: "The Yardbirds/Eric Clapton & Friends: From Yardbirds to Bluesbreakers/01-01 - I Wish You Would (I Wish You Would).flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.title, "I Wish You Would");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "metadata-size-title-suffix");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata across album edition text and title version suffix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-edition-title-suffix-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Daryl Hall & John Oates/Daryl Hall & John Oates - The Essential Collection (2001)/Daryl Hall & John Oates - The Essential Collection (2001) - 13 - Out of Touch.mp3";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-hall-oates",
        name: "The Essential Collection (RCA Records / BMG)",
        artist: "Daryl Hall & John Oates",
        year: 2001,
        songCount: 1
      },
      song: {
        id: "song-out-of-touch",
        title: "Out of Touch (single version)",
        artist: "Daryl Hall & John Oates",
        albumArtist: "Daryl Hall & John Oates",
        album: "The Essential Collection (RCA Records / BMG)",
        track: 13,
        discNumber: 1,
        year: 2001,
        duration: 250,
        size: Buffer.byteLength(contents),
        path: "Daryl Hall & John Oates/The Essential Collection (RCA Records _ BMG)/01-13 - Out of Touch (single version).mp3",
        suffix: "mp3"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.title, "Out of Touch");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "edition-title-suffix-metadata-size");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata across leading artist articles and redundant album years", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-artist-article-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Beach Boys/Beach Boys - Greatest Hits (2012)/Beach Boys - Greatest Hits (2012) - 01 - That's Why God Made the Radio.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-beach-boys",
        name: "Greatest Hits (2012)",
        artist: "The Beach Boys",
        year: 2012,
        songCount: 1
      },
      song: {
        id: "song-radio",
        title: "That's Why God Made the Radio",
        artist: "The Beach Boys",
        albumArtist: "The Beach Boys",
        album: "Greatest Hits (2012)",
        track: 1,
        discNumber: 1,
        year: 2012,
        duration: 200,
        size: Buffer.byteLength(contents),
        path: "The Beach Boys - Beach Boys/Greatest Hits (2012)/01-01 - That's Why God Made the Radio.flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.albumArtist, "The Beach Boys");
    assert.equal(track?.album, "Greatest Hits");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "edition-metadata-size");
    assert.equal(
      track?.targetRelativePath,
      "The Beach Boys/The Beach Boys - Greatest Hits (2012)/The Beach Boys - Greatest Hits (2012) - 01 - That's Why God Made the Radio.flac"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner matches Navidrome metadata when album only differs by edition text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-edition-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "AC DC/AC DC - High Voltage (1994)/AC DC - High Voltage (1994) - 04 - Live Wire.flac";
  const contents = "audio";

  globalThis.fetch = navidromeFetchForSongs([
    {
      album: {
        id: "album-acdc",
        name: "High Voltage (international version)",
        artist: "AC/DC",
        year: 1976,
        songCount: 1
      },
      song: {
        id: "song-live-wire",
        title: "Live Wire",
        artist: "AC/DC",
        albumArtist: "AC/DC",
        album: "High Voltage (international version)",
        track: 4,
        discNumber: 1,
        year: 1976,
        duration: 349,
        size: Buffer.byteLength(contents),
        path: "AC_DC/High Voltage (international version)/01-04 - Live Wire.flac",
        suffix: "flac"
      }
    }
  ]);

  try {
    const filePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.albumArtist, "AC/DC");
    assert.equal(track?.album, "High Voltage (international version)");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "edition-metadata-size");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner falls back to Navidrome search when album catalog misses an edition metadata key", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-search-fallback-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "AC-DC/AC-DC - High Voltage (1989)/AC-DC - High Voltage (1989) - 01 - Baby, Please Don't Go.flac";
  const contents = "audio";

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: {
            album: [
              {
                id: "album-acdc",
                name: "High Voltage (Australian version)",
                artist: "AC/DC",
                year: 1975,
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
            id: "album-acdc",
            name: "High Voltage (Australian version)",
            artist: "AC/DC",
            year: 1975,
            songCount: 1,
            song: [
              {
                id: "song-acdc",
                title: "Baby, Please Don't Go",
                artist: "AC/DC",
                albumArtist: "AC/DC",
                album: "High Voltage (Australian version)",
                track: 1,
                discNumber: 1,
                year: 1975,
                duration: 291,
                path: "AC_DC/High Voltage (Australian version)/01-01 - Baby, Please Don't Go.flac",
                suffix: "flac"
              }
            ]
          }
        }
      });
    }

    if (url.pathname.endsWith("/rest/search3.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          searchResult3: {
            song: [
              {
                id: "song-acdc",
                title: "Baby, Please Don't Go",
                artist: "AC/DC",
                albumArtist: "AC/DC",
                album: "High Voltage (Australian version)",
                track: 1,
                discNumber: 1,
                year: 1975,
                duration: 291,
                size: Buffer.byteLength(contents),
                path: "AC_DC/High Voltage (Australian version)/01-01 - Baby, Please Don't Go.flac",
                suffix: "flac"
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
    await fs.writeFile(filePath, contents);

    const scanSettings = settings(root);
    scanSettings.scan.extensions = [".flac"];
    scanSettings.navidrome.baseUrl = "http://navidrome.local";
    scanSettings.navidrome.username = "admin";
    scanSettings.navidrome.password = "password";
    const result = await scanLibrary(scanSettings);
    const track = result.tracks[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, "navidrome");
    assert.equal(track?.albumArtist, "AC/DC");
    assert.equal(track?.album, "High Voltage (Australian version)");
    assert.equal(track?.navidromeEnrichment?.matchMethod, "edition-metadata-size");
    assert.ok(result.warnings.some((warning) => warning.includes("matched through Navidrome search fallback")));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("organized local file without Navidrome API match keeps local metadata with a clear diagnostic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-unmatched-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 01 - Track Name.mp3";

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: {
            album: [
              {
                id: "album-other",
                name: "Other Album",
                artist: "Other Artist",
                year: 2024,
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
            id: "album-other",
            name: "Other Album",
            artist: "Other Artist",
            year: 2024,
            songCount: 1,
            song: [
              {
                id: "song-other",
                title: "Other Song",
                artist: "Other Artist",
                albumArtist: "Other Artist",
                album: "Other Album",
                track: 1,
                year: 2024,
                duration: 200,
                path: "Other Artist/Other Artist - Other Album (2024)/Other Artist - Other Album (2024) - 01 - Other Song.mp3",
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
    const plan = await buildOrganizePlan(result.tracks, scanSettings);
    const item = plan.items[0];

    assert.equal(result.tracks.length, 1);
    assert.equal(track?.targetSource, undefined);
    assert.equal(track?.navidromeEnrichment?.code, "possible-stale-scan");
    assert.match(track?.navidromeEnrichment?.message ?? "", /inspect match details/i);
    assert.equal(item?.status, "metadata-review");
    assert.equal(item?.targetSource, "naviclean");
    assert.equal(item?.targetRelativePath, sourceRelativePath);
    assert.equal(item?.navidromeEnrichment?.code, "possible-stale-scan");
    assert.ok(plan.warnings.some((warning) => /inspect match details/i.test(warning)));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("scanner counts and reports Navidrome API paths outside the configured library root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-scanner-navidrome-outside-"));
  const originalFetch = globalThis.fetch;
  const sourceRelativePath =
    "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 01 - Track Name.mp3";

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/rest/getAlbumList2.view")) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          albumList2: {
            album: [
              {
                id: "album-outside",
                name: "Outside Album",
                artist: "Outside Artist",
                year: 2025,
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
            id: "album-outside",
            name: "Outside Album",
            artist: "Outside Artist",
            year: 2025,
            songCount: 1,
            song: [
              {
                id: "song-outside",
                title: "Outside Song",
                artist: "Outside Artist",
                albumArtist: "Outside Artist",
                album: "Outside Album",
                track: 1,
                year: 2025,
                duration: 210,
                path: "/outside-mount/Outside Artist/Outside Song.mp3",
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

    assert.ok(
      result.warnings.some((warning) =>
        warning.includes("1 indexed tracks point outside the configured library root")
      ),
      result.warnings.join("\n")
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

function navidromeFetchForSongs(entries: Array<{ album: Record<string, unknown>; song: Record<string, unknown> }>) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));

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

function wavSilence(durationSeconds: number) {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = Math.round(durationSeconds * byteRate);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function id3TaggedMp3(tags: {
  album: string;
  albumArtist: string;
  artist: string;
  title: string;
  track: string;
  year: string;
}) {
  const frames = [
    id3TextFrame("TIT2", tags.title),
    id3TextFrame("TPE1", tags.artist),
    id3TextFrame("TPE2", tags.albumArtist),
    id3TextFrame("TALB", tags.album),
    id3TextFrame("TRCK", tags.track),
    id3TextFrame("TYER", tags.year)
  ];
  const body = Buffer.concat(frames);

  return Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([3, 0, 0]),
    id3SynchsafeSize(body.length),
    body,
    Buffer.from("audio", "ascii")
  ]);
}

function id3TextFrame(id: string, value: string) {
  const content = Buffer.concat([Buffer.from([0]), Buffer.from(value, "latin1")]);
  const header = Buffer.alloc(10);

  header.write(id, 0, 4, "ascii");
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content]);
}

function id3SynchsafeSize(size: number) {
  return Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f
  ]);
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
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}
