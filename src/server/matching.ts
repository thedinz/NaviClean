import type { TrackFile } from "../shared/types.js";
import { normalizeForMatch } from "./utils.js";

type DuplicateKeyValues = {
  artist: string;
  album: string;
  albumType: string;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  duration: number | null;
  isrc?: string | null;
};

const unknownMatchValues = new Set(["", "unknown artist", "unknown album", "unknown track"]);

export function duplicateKeyForTrack(track: TrackFile) {
  return buildDuplicateKey({
    artist: track.albumArtist || track.artist,
    album: track.album,
    albumType: track.albumType || "Album",
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    year: track.year,
    duration: track.duration
  });
}

export function buildDuplicateKey(values: DuplicateKeyValues) {
  const artist = normalizeDuplicateField(values.artist);
  const album = normalizeDuplicateField(values.album);
  const albumType = normalizeDuplicateField(values.albumType || "Album");
  const title = normalizeDuplicateTitle(values.title);

  if (isUnknownMatchValue(artist) || isUnknownMatchValue(album) || isUnknownMatchValue(title)) {
    return "";
  }

  if (!values.trackNumber) {
    return "";
  }

  const releaseYear = values.year ?? "unknown-year";
  const releaseKey = [artist, albumType, releaseYear, album].join("|");
  const trackSlot = [values.discNumber ?? 1, values.trackNumber].join("/");
  const isrc = values.isrc ? normalizeDuplicateField(values.isrc) : "";

  if (isrc) {
    return ["release", releaseKey, trackSlot, title, `isrc:${isrc}`].join("|");
  }

  if (!values.duration) {
    return "";
  }

  return ["release", releaseKey, trackSlot, title, durationBucket(values.duration)].join("|");
}

function normalizeDuplicateField(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

function normalizeDuplicateTitle(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

function isUnknownMatchValue(value: string) {
  return unknownMatchValues.has(value);
}

function durationBucket(duration: number | null) {
  return duration ? `duration:${Math.round(duration / 2) * 2}` : "unknown-duration";
}
