import path from "node:path";
import type { NavidromeMetadataMatchMethod, TrackFile } from "../shared/types.js";
import type { NavidromeLibraryTrack } from "./navidrome.js";
import { normalizeForMatch } from "./utils.js";

/** The fields every match tier reads, taken from either a local file or a Navidrome record. */
type MatchFields = {
  absolutePath: string | null;
  relativePath: string | null;
  size: number | null;
  albumArtist: string;
  album: string;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
  duration: number | null;
};

type MatchTier = {
  method: NavidromeMetadataMatchMethod;
  /** Path tiers take the last record per key; metadata tiers only accept a key held by exactly one record. */
  requireUnique: boolean;
  key: (fields: MatchFields) => string;
  /** Prose used in scan diagnostics. */
  description: string;
  /** Compact form used on the diagnostics page. */
  label: string;
};

export type NavidromeTrackMatch = {
  track: NavidromeLibraryTrack;
  method: NavidromeMetadataMatchMethod;
};

/** Per tier: key -> record, or null when several records share the key (ambiguous). */
export type NavidromeMatchIndex = Map<NavidromeMetadataMatchMethod, Map<string, NavidromeLibraryTrack | null>>;

/**
 * Ways a local file can be matched to a Navidrome record, strongest first. A file is matched by
 * the first tier that finds a record; later tiers relax one field at a time and all but the
 * path tiers require the file size to agree.
 */
const matchTiers: MatchTier[] = [
  {
    method: "absolute-path",
    requireUnique: false,
    key: (fields) => (fields.absolutePath ? navidromePathKey(fields.absolutePath) : ""),
    description: "absolute path",
    label: "absolute path"
  },
  {
    method: "relative-path",
    requireUnique: false,
    key: (fields) => (fields.relativePath ? navidromeRelativePathKey(fields.relativePath) : ""),
    description: "relative path",
    label: "relative path"
  },
  {
    method: "filename-size",
    requireUnique: true,
    key: (fields) => filenameSizeKey(fields.relativePath, fields.size),
    description: "filename and size",
    label: "filename+size"
  },
  {
    method: "metadata-key",
    requireUnique: true,
    key: metadataKey,
    description: "metadata key",
    label: "metadata key"
  },
  {
    method: "metadata-size-relaxed-duration",
    requireUnique: true,
    key: (fields) => slotKey(fields, { album: exactText, title: exactText }),
    description: "metadata and exact size",
    label: "metadata+size"
  },
  {
    method: "edition-metadata-size",
    requireUnique: true,
    key: (fields) => slotKey(fields, { album: editionText, title: exactText }),
    description: "edition-compatible metadata and size",
    label: "edition-compatible metadata+size"
  },
  {
    method: "metadata-size-title-suffix",
    requireUnique: true,
    key: (fields) => slotKey(fields, { album: exactText, title: suffixFreeTitle }),
    description: "metadata and size with a compatible title suffix",
    label: "metadata+size with compatible title suffix"
  },
  {
    method: "edition-title-suffix-metadata-size",
    requireUnique: true,
    key: (fields) => slotKey(fields, { album: editionText, title: suffixFreeTitle }),
    description: "edition-compatible metadata and size with a compatible title suffix",
    label: "edition-compatible metadata+size with compatible title suffix"
  },
  {
    method: "metadata-size-track-agnostic",
    requireUnique: true,
    key: trackAgnosticKey,
    description: "metadata and size without release track number",
    label: "metadata+size without track number"
  },
  {
    method: "metadata-size-artist-agnostic",
    requireUnique: true,
    key: artistAgnosticKey,
    description: "release slot metadata and size without album artist",
    label: "release slot metadata+size without album artist"
  }
];

const tiersByMethod = new Map(matchTiers.map((tier) => [tier.method, tier]));

export function buildNavidromeMatchIndex(tracks: NavidromeLibraryTrack[]): NavidromeMatchIndex {
  const index: NavidromeMatchIndex = new Map(matchTiers.map((tier) => [tier.method, new Map()]));

  for (const track of tracks) {
    const fields = fieldsFromNavidrome(track);

    for (const tier of matchTiers) {
      const key = tier.key(fields);
      const entries = index.get(tier.method)!;

      if (!key) {
        continue;
      }

      entries.set(key, tier.requireUnique && entries.has(key) ? null : track);
    }
  }

  return index;
}

/** The record a full scan would match this file to, using the first tier that finds one. */
export function findIndexedNavidromeMatch(index: NavidromeMatchIndex, track: TrackFile): NavidromeTrackMatch | null {
  const fields = fieldsFromTrack(track);

  for (const tier of matchTiers) {
    const match = index.get(tier.method)!.get(tier.key(fields));

    if (match) {
      return { track: match, method: tier.method };
    }
  }

  return null;
}

/**
 * What the index holds for this file under one tier: a record, null when the key is ambiguous,
 * or undefined when no record has the key.
 */
export function indexedNavidromeLookup(
  index: NavidromeMatchIndex,
  track: TrackFile,
  method: NavidromeMetadataMatchMethod
): NavidromeLibraryTrack | null | undefined {
  const tier = tiersByMethod.get(method)!;
  return index.get(method)!.get(tier.key(fieldsFromTrack(track)));
}

/** The strongest tier under which a single candidate record matches this file, if any. */
export function navidromeCandidateMatchMethod(track: TrackFile, candidate: NavidromeLibraryTrack) {
  return navidromeCandidateMatchMethods(track, candidate)[0] ?? null;
}

/** Every tier under which a single candidate record matches this file, strongest first. */
export function navidromeCandidateMatchMethods(track: TrackFile, candidate: NavidromeLibraryTrack) {
  const localFields = fieldsFromTrack(track);
  const candidateFields = fieldsFromNavidrome(candidate);

  return matchTiers
    .filter((tier) => {
      const localKey = tier.key(localFields);
      return Boolean(localKey) && localKey === tier.key(candidateFields);
    })
    .map((tier) => tier.method);
}

export function navidromeMatchDescription(method: NavidromeMetadataMatchMethod) {
  return tiersByMethod.get(method)?.description ?? "metadata key";
}

export function navidromeMatchLabel(method: NavidromeMetadataMatchMethod) {
  return tiersByMethod.get(method)?.label ?? "metadata key";
}

export function navidromeMetadataKeysMatch(track: TrackFile, candidate: NavidromeLibraryTrack) {
  return metadataKey(fieldsFromTrack(track)) === metadataKey(fieldsFromNavidrome(candidate));
}

export function navidromePathKey(value: string) {
  return path.resolve(value).toLowerCase();
}

export function navidromeRelativePathKey(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function filenameSizeKey(relativePath: string | null, size: number | null) {
  if (!relativePath || !size) {
    return "";
  }

  return `${path.posix.basename(relativePath.replace(/\\/g, "/")).toLowerCase()}|${size}`;
}

/** Durations are compared in 2-second buckets, since decoders report slightly different lengths. */
export function durationBucket(duration: number | null) {
  return duration ? Math.round(duration / 2) * 2 : "";
}

/**
 * Whether a trailing "(...)" on a title is noise rather than a real version: a repeat of the
 * title, "Single Version", a release group tag, or an artist disambiguation from a provider.
 */
export function titleSuffixIsNoise(baseTitle: string, suffix: string, albumArtist: string) {
  const normalizedBaseTitle = exactText(baseTitle);
  const normalizedSuffix = exactText(suffix);

  if (normalizedBaseTitle && normalizedBaseTitle === normalizedSuffix) {
    return true;
  }

  if (normalizedSuffix === "single version" || normalizedSuffix === "pmedia") {
    return true;
  }

  const normalizedArtist = artistText(albumArtist);
  return Boolean(
    normalizedArtist &&
      normalizedSuffix.includes(normalizedArtist) &&
      /\b(?:music|singer|artist|band|born|b\s+\d{4})\b/.test(normalizedSuffix)
  );
}

function fieldsFromTrack(track: TrackFile): MatchFields {
  return {
    absolutePath: track.absolutePath,
    relativePath: track.relativePath,
    size: track.size,
    albumArtist: track.albumArtist || track.artist,
    album: track.album,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    duration: track.duration
  };
}

function fieldsFromNavidrome(track: NavidromeLibraryTrack): MatchFields {
  return {
    absolutePath: track.sourceAbsolutePath,
    relativePath: track.sourceRelativePath,
    size: track.size,
    albumArtist: track.albumArtist || track.artist,
    album: track.album,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    duration: track.duration
  };
}

function metadataKey(fields: MatchFields) {
  return [
    exactText(fields.albumArtist),
    exactText(fields.album),
    exactText(fields.title),
    fields.discNumber ?? 1,
    fields.trackNumber ?? "",
    durationBucket(fields.duration),
    fields.size ?? ""
  ].join("|");
}

/** Album artist, album, title and disc/track slot plus exact size; the album and title normalizers vary per tier. */
function slotKey(
  fields: MatchFields,
  normalize: { album: (value: string) => string; title: (value: string, albumArtist: string) => string }
) {
  if (!fields.albumArtist || !fields.album || !fields.title || !fields.trackNumber || !fields.size) {
    return "";
  }

  return [
    artistText(fields.albumArtist),
    normalize.album(fields.album),
    normalize.title(fields.title, fields.albumArtist),
    fields.discNumber ?? 1,
    fields.trackNumber,
    fields.size
  ].join("|");
}

function trackAgnosticKey(fields: MatchFields) {
  if (!fields.albumArtist || !fields.album || !fields.title || !fields.size) {
    return "";
  }

  return [artistText(fields.albumArtist), editionText(fields.album), exactText(fields.title), fields.size].join("|");
}

function artistAgnosticKey(fields: MatchFields) {
  if (!fields.album || !fields.title || !fields.trackNumber || !fields.size) {
    return "";
  }

  return [editionText(fields.album), exactText(fields.title), fields.discNumber ?? 1, fields.trackNumber, fields.size].join("|");
}

/** Normalized text that keeps bracketed parts, so "(Live)" still distinguishes releases. */
function exactText(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

/** Normalized text without bracketed parts, so "(Deluxe Edition)" and similar are ignored. */
function editionText(value: string) {
  return normalizeForMatch(value);
}

function artistText(value: string) {
  return exactText(value).replace(/^the\s+/, "");
}

function suffixFreeTitle(title: string, albumArtist: string) {
  const stripped = title
    .replace(/\s+\(([^)]*)\)\s*$/i, (match, suffix: string, offset: number, fullValue: string) =>
      titleSuffixIsNoise(fullValue.slice(0, offset), suffix, albumArtist) ? "" : match
    )
    .trim();

  return exactText(stripped);
}
