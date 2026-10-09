import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import type { NavidromeLibraryTrack } from "../src/server/navidrome.js";
import {
  buildNavidromeMatchIndex,
  findIndexedNavidromeMatch,
  indexedNavidromeLookup,
  navidromeCandidateMatchMethod
} from "../src/server/navidrome-matching.js";

test("a path match wins over every metadata tier", () => {
  const local = localTrack();
  const byPath = navidromeTrack({ id: "by-path", sourceAbsolutePath: local.absolutePath, title: "Something Else" });
  const byMetadata = navidromeTrack({ id: "by-metadata", sourceAbsolutePath: null, sourceRelativePath: null });

  const match = findIndexedNavidromeMatch(buildNavidromeMatchIndex([byMetadata, byPath]), local);

  assert.equal(match?.track.id, "by-path");
  assert.equal(match?.method, "absolute-path");
});

test("a metadata key shared by two records is ambiguous and never matches", () => {
  const local = localTrack({ absolutePath: path.resolve("/music/elsewhere.mp3"), relativePath: "elsewhere.mp3" });
  const first = navidromeTrack({ id: "first", sourceAbsolutePath: null, sourceRelativePath: null });
  const second = navidromeTrack({ id: "second", sourceAbsolutePath: null, sourceRelativePath: null });
  const index = buildNavidromeMatchIndex([first, second]);

  assert.equal(findIndexedNavidromeMatch(index, local), null);
  assert.equal(indexedNavidromeLookup(index, local, "metadata-key"), null);
  assert.equal(navidromeCandidateMatchMethod(local, first), "metadata-key");
});

test("a provider title suffix is ignored by the title-suffix tier", () => {
  const local = localTrack({ absolutePath: path.resolve("/music/x.mp3"), relativePath: "x.mp3", title: "Track (Single Version)" });
  const candidate = navidromeTrack({ sourceAbsolutePath: null, sourceRelativePath: null, duration: 999 });

  assert.equal(navidromeCandidateMatchMethod(local, candidate), "metadata-size-title-suffix");
});

function localTrack(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "local",
    absolutePath: path.resolve("/music/Artist/Album/01 - Track.mp3"),
    relativePath: "Artist/Album/01 - Track.mp3",
    extension: ".mp3",
    size: 1234,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Track",
    trackNumber: 1,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 1,
    year: 2020,
    duration: 200,
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

function navidromeTrack(overrides: Partial<NavidromeLibraryTrack> = {}): NavidromeLibraryTrack {
  return {
    id: "navidrome",
    title: "Track",
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    trackNumber: 1,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 1,
    year: 2020,
    duration: 200,
    size: 1234,
    bitrate: null,
    isrc: null,
    sourceRawPath: null,
    sourceAbsolutePath: path.resolve("/music/Artist/Album/01 - Track.mp3"),
    sourceRelativePath: "Artist/Album/01 - Track.mp3",
    sourcePathStatus: "usable",
    ...overrides
  } as NavidromeLibraryTrack;
}
