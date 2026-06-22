import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildLibraryAlbums, buildLibraryArtists, findLibraryAlbumTracks, findLibraryArtistTracks, trashLibraryTracks } from "../src/server/library.js";
import type { PrivateSettings } from "../src/server/settings.js";
import type { TrackFile } from "../src/shared/types.js";

test("library summaries group artists, albums, formats, and sorted tracks", () => {
  const tracks = [
    track({ id: "two", album: "Album", title: "Two", trackNumber: 2, extension: ".mp3", size: 2 }),
    track({ id: "one", album: "Album", title: "One", trackNumber: 1, extension: ".flac", size: 4, year: 2026 }),
    track({ id: "other", albumArtist: "Other Artist", artist: "Other Artist", album: "Elsewhere" })
  ];

  const artists = buildLibraryArtists(tracks);
  const artist = artists.find((candidate) => candidate.name === "Artist");

  assert.ok(artist);
  assert.equal(artist.albumCount, 1);
  assert.equal(artist.trackCount, 2);
  assert.deepEqual(artist.formats, ["FLAC", "MP3"]);

  const albums = buildLibraryAlbums(tracks, artist.id);

  assert.ok(albums);
  assert.equal(albums.length, 1);
  const album = albums[0];
  assert.ok(album);
  assert.equal(album.title, "Album");
  assert.equal(album.trackCount, 2);
  assert.equal(album.yearLabel, "2026");

  const albumTracks = findLibraryAlbumTracks(tracks, artist.id, album.id);

  assert.deepEqual(albumTracks?.map((candidate) => candidate.id), ["one", "two"]);
});

test("trashing an artist recycles all artist tracks and prunes empty folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-library-"));

  try {
    const artistTrackPath = path.join(root, "Artist", "Album", "01 - One.mp3");
    const secondArtistTrackPath = path.join(root, "Artist", "Album", "02 - Two.mp3");
    const otherTrackPath = path.join(root, "Other Artist", "Elsewhere", "01 - Else.mp3");

    for (const filePath of [artistTrackPath, secondArtistTrackPath, otherTrackPath]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, path.basename(filePath));
    }

    const tracks = [
      track({
        id: "one",
        absolutePath: artistTrackPath,
        relativePath: "Artist/Album/01 - One.mp3",
        title: "One",
        trackNumber: 1
      }),
      track({
        id: "two",
        absolutePath: secondArtistTrackPath,
        relativePath: "Artist/Album/02 - Two.mp3",
        title: "Two",
        trackNumber: 2
      }),
      track({
        id: "else",
        albumArtist: "Other Artist",
        artist: "Other Artist",
        album: "Elsewhere",
        absolutePath: otherTrackPath,
        relativePath: "Other Artist/Elsewhere/01 - Else.mp3",
        title: "Else"
      })
    ];
    const artist = buildLibraryArtists(tracks).find((candidate) => candidate.name === "Artist");
    const artistTracks = artist ? findLibraryArtistTracks(tracks, artist.id) : null;

    assert.ok(artistTracks);

    const result = await trashLibraryTracks(settings(root), tracks, artistTracks.map((candidate) => candidate.id));

    assert.equal(result.trashed, 2);
    assert.deepEqual(new Set(result.removedTrackIds), new Set(["one", "two"]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tracks.map((candidate) => candidate.id), ["else"]);
    await assert.rejects(fs.access(artistTrackPath), /ENOENT/);
    await assert.rejects(fs.access(secondArtistTrackPath), /ENOENT/);
    await assert.rejects(fs.access(path.join(root, "Artist")), /ENOENT/);
    await fs.access(otherTrackPath);

    const trashGroups = await fs.readdir(path.join(root, ".naviclean-trash"));
    assert.equal(trashGroups.length, 1);
    await fs.access(path.join(root, ".naviclean-trash", trashGroups[0], "Artist", "Album", "01 - One.mp3"));
    await fs.access(path.join(root, ".naviclean-trash", trashGroups[0], "Artist", "Album", "02 - Two.mp3"));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

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
      extensions: [".mp3", ".flac"]
    }
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  const id = overrides.id || "track";

  return {
    id,
    absolutePath: `C:/music/${id}.mp3`,
    relativePath: `${id}.mp3`,
    extension: ".mp3",
    size: 1,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Track",
    trackNumber: 1,
    trackTotal: 2,
    discNumber: 1,
    discTotal: 1,
    year: 2026,
    duration: 180,
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
