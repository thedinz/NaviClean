import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hasSpotifyBuIdentityTags, scanLibrary } from "../src/server/scanner.js";
import { buildOrganizePlan } from "../src/server/organizer.js";
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
    assert.equal(item?.status, "same");
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
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}
