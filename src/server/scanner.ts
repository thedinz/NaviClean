import { parseFile } from "music-metadata";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NavidromeMetadataEnrichment, NavidromeMetadataMatchMethod, ScanStatus, TrackFile } from "../shared/types.js";
import { loadCatalog, saveCatalog } from "./catalog.js";
import { buildDuplicateKey } from "./matching.js";
import { loadMetadataOverrides, validMetadataOverride, type MetadataOverride } from "./metadata-overrides.js";
import { fetchNavidromeLibraryTracks, searchNavidromeLibraryTrackCandidates, type NavidromeLibraryTrack } from "./navidrome.js";
import { targetForTrack } from "./organizer.js";
import { preserveOrganizationSkipDecisions } from "./organize-skip.js";
import type { PrivateSettings } from "./settings.js";
import { hasTrackKeepIdentityTags } from "./trackkeep.js";
import {
  cleanDisplayValue,
  normalizeForMatch,
  repairUtf16MojibakeText,
  sha1,
  titleFromFilename,
  toPosixRelative
} from "./utils.js";

export { hasTrackKeepIdentityTags };

type ProgressHandler = (status: Partial<ScanStatus>) => void;
type ParsedAudioMetadata = Awaited<ReturnType<typeof parseFile>>;
type StructuredPathIdentityReason = "missing-tags" | "placeholder-tags" | "conflicting-tags";

const extensionQuality: Record<string, number> = {
  ".flac": 1000,
  ".alac": 960,
  ".wav": 920,
  ".aiff": 900,
  ".aif": 900,
  ".opus": 760,
  ".ogg": 720,
  ".m4a": 680,
  ".aac": 650,
  ".mp3": 550,
  ".wma": 420
};
export async function scanLibrary(settings: PrivateSettings, onProgress?: ProgressHandler) {
  const root = path.resolve(settings.naming.libraryPath);
  const extensions = new Set(settings.scan.extensions.map((extension) => extension.toLowerCase()));
  const recycleRoot = path.resolve(settings.naming.recycleBinPath);
  const files = await collectAudioFiles(root, extensions, recycleRoot, onProgress);
  const tracks: TrackFile[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const metadataOverrides = await loadMetadataOverrides();

  for (const filePath of files) {
    try {
      const track = await readTrack(filePath, root, settings, metadataOverrides);
      tracks.push(track);
    } catch (error) {
      const message = `${toPosixRelative(root, filePath)}: ${(error as Error).message}`;
      errors.push(message);
      if (errors.length > 100) {
        errors.shift();
      }
    }

    onProgress?.({
      audioFiles: tracks.length,
      errors
    });
  }

  const navidromeEnriched = await enrichTracksWithNavidromeMetadata(settings, tracks);

  for (const warning of navidromeEnriched.warnings) {
    warnings.push(warning);
  }

  const latestCatalog = await loadCatalog();
  const nextTracks = preserveOrganizationSkipDecisions(navidromeEnriched.tracks, latestCatalog.tracks);
  await saveCatalog(nextTracks);
  return { tracks: nextTracks, errors, warnings };
}

async function enrichTracksWithNavidromeMetadata(settings: PrivateSettings, tracks: TrackFile[]) {
  const warnings: string[] = [];

  if (!settings.navidrome.baseUrl || !settings.navidrome.username || !settings.navidrome.password) {
    return {
      tracks: tracks.map((track) =>
        withNavidromeDiagnostic(track, {
          status: "skipped",
          code: "settings-missing",
          message: "Navidrome metadata was not checked because the Navidrome URL, username, or password is missing."
        })
      ),
      warnings: tracks.length
        ? [`Navidrome metadata: settings missing; skipped enrichment for ${tracks.length.toLocaleString()} files.`]
        : warnings
    };
  }

  let navidromeTracks: NavidromeLibraryTrack[];

  try {
    navidromeTracks = await fetchNavidromeLibraryTracks(settings);
  } catch (error) {
    return {
      tracks: tracks.map((track) =>
        withNavidromeDiagnostic(track, {
          status: "skipped",
          code: "api-request-failed",
          message: `Navidrome metadata was not checked because the API request failed: ${(error as Error).message}`
        })
      ),
      warnings: [`Navidrome metadata scan skipped: ${(error as Error).message}`]
    };
  }

  if (navidromeTracks.length === 0) {
    return {
      tracks: tracks.map((track) =>
        withNavidromeDiagnostic(track, {
          status: "skipped",
          code: "zero-tracks",
          message: "Navidrome returned zero tracks, so NaviClean used local file metadata and path inference."
        })
      ),
      warnings: ["Navidrome metadata scan returned no tracks; local file metadata was used."]
    };
  }

  const index = buildNavidromeTrackIndex(navidromeTracks);
  let matched = 0;
  let searchFallbackMatched = 0;
  let searchFallbackFailures = 0;
  const unmatchedExamples: string[] = [];
  const unmatchedTracks: Array<{ index: number; track: TrackFile }> = [];
  const enrichedTracks: TrackFile[] = new Array(tracks.length);

  tracks.forEach((track, trackIndex) => {
    const navidromeMatch = findNavidromeTrackForFile(index, track);

    if (!navidromeMatch) {
      unmatchedTracks.push({ index: trackIndex, track });
      return;
    }

    matched += 1;
    enrichedTracks[trackIndex] = trackFileFromNavidromeTrack(track, navidromeMatch.track, settings, navidromeMatch.method, navidromeTracks.length);
  });

  for (let offset = 0; offset < unmatchedTracks.length; offset += 6) {
    const batch = unmatchedTracks.slice(offset, offset + 6);
    const batchMatches = await Promise.all(
      batch.map(async ({ track }) => {
        try {
          return await findNavidromeSearchFallbackForFile(settings, track);
        } catch {
          searchFallbackFailures += 1;
          return null;
        }
      })
    );

    batch.forEach(({ index: trackIndex, track }, batchIndex) => {
      const navidromeMatch = batchMatches[batchIndex];

      if (!navidromeMatch) {
        if (unmatchedExamples.length < 5) {
          unmatchedExamples.push(track.relativePath);
        }
        enrichedTracks[trackIndex] = withNavidromeDiagnostic(track, unmatchedNavidromeDiagnostic(track, navidromeTracks.length));
        return;
      }

      matched += 1;
      searchFallbackMatched += 1;
      enrichedTracks[trackIndex] = trackFileFromNavidromeTrack(track, navidromeMatch.track, settings, navidromeMatch.method, navidromeTracks.length);
    });
  }
  const tracksWithUsablePaths = navidromeTracks.filter((track) => track.sourcePathStatus === "usable").length;
  const tracksWithoutPaths = navidromeTracks.filter((track) => track.sourcePathStatus === "missing").length;
  const tracksOutsideLibrary = navidromeTracks.filter((track) => track.sourcePathStatus === "outside-library-root").length;
  const unmatchedDiagnostics = enrichedTracks
    .map((track) => track.navidromeEnrichment)
    .filter((diagnostic): diagnostic is NavidromeMetadataEnrichment => Boolean(diagnostic));
  const noApiMatchCount = unmatchedDiagnostics.filter((diagnostic) => diagnostic.code === "no-api-match").length;
  const possibleStaleScanCount = unmatchedDiagnostics.filter((diagnostic) => diagnostic.code === "possible-stale-scan").length;

  warnings.push(
    `Navidrome metadata: ${matched.toLocaleString()} matched / ${tracks.length.toLocaleString()} files (${navidromeTracks.length.toLocaleString()} indexed tracks).`
  );

  if (searchFallbackMatched > 0) {
    warnings.push(
      `Navidrome metadata: ${searchFallbackMatched.toLocaleString()} files matched through Navidrome search fallback after the full album catalog did not expose a matching key.`
    );
  }

  if (searchFallbackFailures > 0) {
    warnings.push(
      `Navidrome metadata: search fallback failed for ${searchFallbackFailures.toLocaleString()} unmatched files.`
    );
  }

  if (tracksWithoutPaths > 0) {
    warnings.push(
      `Navidrome metadata: ${tracksWithoutPaths.toLocaleString()} indexed tracks did not expose a usable path.`
    );
  }

  if (tracksOutsideLibrary > 0) {
    warnings.push(
      `Navidrome metadata: ${tracksOutsideLibrary.toLocaleString()} indexed tracks point outside the configured library root (${path.resolve(settings.naming.libraryPath)}).`
    );
  }

  if (tracksWithUsablePaths < navidromeTracks.length) {
    warnings.push(
      `Navidrome metadata: ${(navidromeTracks.length - tracksWithUsablePaths).toLocaleString()} indexed tracks did not expose a usable path under the library mount.`
    );
  }

  if (noApiMatchCount > 0) {
    warnings.push(
      `Navidrome metadata: ${noApiMatchCount.toLocaleString()} local files did not match any Navidrome API record by absolute path, relative path, filename+size, metadata key, or metadata+size.`
    );
  }

  if (possibleStaleScanCount > 0) {
    warnings.push(
      `Navidrome metadata: ${possibleStaleScanCount.toLocaleString()} organized local files did not match any Navidrome API record by path or metadata+size. If these files were recently moved, rescan Navidrome; otherwise inspect match details for metadata/path differences.`
    );
  }

  if (matched < tracks.length && unmatchedExamples.length > 0) {
    warnings.push(`Navidrome unmatched examples: ${unmatchedExamples.join("; ")}`);
  }

  return {
    tracks: enrichedTracks,
    warnings
  };
}

type NavidromeTrackIndex = {
  byAbsolutePath: Map<string, NavidromeLibraryTrack>;
  byRelativePath: Map<string, NavidromeLibraryTrack>;
  byFilenameAndSize: Map<string, NavidromeLibraryTrack | null>;
  byMetadata: Map<string, NavidromeLibraryTrack | null>;
  byMetadataRelaxedDuration: Map<string, NavidromeLibraryTrack | null>;
  byEditionMetadata: Map<string, NavidromeLibraryTrack | null>;
  byTitleSuffixMetadata: Map<string, NavidromeLibraryTrack | null>;
  byEditionTitleSuffixMetadata: Map<string, NavidromeLibraryTrack | null>;
  byTrackAgnosticMetadata: Map<string, NavidromeLibraryTrack | null>;
  byArtistAgnosticMetadata: Map<string, NavidromeLibraryTrack | null>;
};

type NavidromeTrackMatch = {
  track: NavidromeLibraryTrack;
  method: NavidromeMetadataMatchMethod;
};

function buildNavidromeTrackIndex(tracks: NavidromeLibraryTrack[]): NavidromeTrackIndex {
  const index: NavidromeTrackIndex = {
    byAbsolutePath: new Map(),
    byRelativePath: new Map(),
    byFilenameAndSize: new Map(),
    byMetadata: new Map(),
    byMetadataRelaxedDuration: new Map(),
    byEditionMetadata: new Map(),
    byTitleSuffixMetadata: new Map(),
    byEditionTitleSuffixMetadata: new Map(),
    byTrackAgnosticMetadata: new Map(),
    byArtistAgnosticMetadata: new Map()
  };

  for (const track of tracks) {
    if (track.sourceAbsolutePath) {
      index.byAbsolutePath.set(pathKey(track.sourceAbsolutePath), track);
    }

    if (track.sourceRelativePath) {
      index.byRelativePath.set(relativePathKey(track.sourceRelativePath), track);
      addUniqueNavidromeMatch(index.byFilenameAndSize, filenameSizeKey(track.sourceRelativePath, track.size), track);
    }

    addUniqueNavidromeMatch(index.byMetadata, navidromeMetadataKey(track), track);
    addUniqueNavidromeMatch(index.byMetadataRelaxedDuration, navidromeRelaxedDurationKey(track), track);
    addUniqueNavidromeMatch(index.byEditionMetadata, navidromeEditionMetadataKey(track), track);
    addUniqueNavidromeMatch(index.byTitleSuffixMetadata, navidromeTitleSuffixMetadataKey(track), track);
    addUniqueNavidromeMatch(index.byEditionTitleSuffixMetadata, navidromeEditionTitleSuffixMetadataKey(track), track);
    addUniqueNavidromeMatch(index.byTrackAgnosticMetadata, navidromeTrackAgnosticMetadataKey(track), track);
    addUniqueNavidromeMatch(index.byArtistAgnosticMetadata, navidromeArtistAgnosticMetadataKey(track), track);
  }

  return index;
}

function findNavidromeTrackForFile(index: NavidromeTrackIndex, track: TrackFile): NavidromeTrackMatch | null {
  const absolutePathMatch = index.byAbsolutePath.get(pathKey(track.absolutePath));
  if (absolutePathMatch) {
    return { track: absolutePathMatch, method: "absolute-path" };
  }

  const relativePathMatch = index.byRelativePath.get(relativePathKey(track.relativePath));
  if (relativePathMatch) {
    return { track: relativePathMatch, method: "relative-path" };
  }

  const filenameSizeMatch = uniqueNavidromeMatch(index.byFilenameAndSize.get(filenameSizeKey(track.relativePath, track.size)));
  if (filenameSizeMatch) {
    return { track: filenameSizeMatch, method: "filename-size" };
  }

  const metadataMatch = uniqueNavidromeMatch(index.byMetadata.get(trackMetadataKey(track)));
  if (metadataMatch) {
    return { track: metadataMatch, method: "metadata-key" };
  }

  const relaxedDurationMatch = uniqueNavidromeMatch(
    index.byMetadataRelaxedDuration.get(trackRelaxedDurationKey(track))
  );
  if (relaxedDurationMatch) {
    return { track: relaxedDurationMatch, method: "metadata-size-relaxed-duration" };
  }

  const editionMetadataMatch = uniqueNavidromeMatch(index.byEditionMetadata.get(trackEditionMetadataKey(track)));
  if (editionMetadataMatch) {
    return { track: editionMetadataMatch, method: "edition-metadata-size" };
  }

  const titleSuffixMetadataMatch = uniqueNavidromeMatch(index.byTitleSuffixMetadata.get(trackTitleSuffixMetadataKey(track)));
  if (titleSuffixMetadataMatch) {
    return { track: titleSuffixMetadataMatch, method: "metadata-size-title-suffix" };
  }

  const editionTitleSuffixMetadataMatch = uniqueNavidromeMatch(
    index.byEditionTitleSuffixMetadata.get(trackEditionTitleSuffixMetadataKey(track))
  );
  if (editionTitleSuffixMetadataMatch) {
    return { track: editionTitleSuffixMetadataMatch, method: "edition-title-suffix-metadata-size" };
  }

  const trackAgnosticMetadataMatch = uniqueNavidromeMatch(index.byTrackAgnosticMetadata.get(trackTrackAgnosticMetadataKey(track)));
  if (trackAgnosticMetadataMatch) {
    return { track: trackAgnosticMetadataMatch, method: "metadata-size-track-agnostic" };
  }

  const artistAgnosticMetadataMatch = uniqueNavidromeMatch(index.byArtistAgnosticMetadata.get(trackArtistAgnosticMetadataKey(track)));
  if (artistAgnosticMetadataMatch) {
    return { track: artistAgnosticMetadataMatch, method: "metadata-size-artist-agnostic" };
  }

  return null;
}

async function findNavidromeSearchFallbackForFile(
  settings: PrivateSettings,
  track: TrackFile
): Promise<NavidromeTrackMatch | null> {
  const result = await searchNavidromeLibraryTrackCandidates(settings, {
    album: track.album,
    albumArtist: track.albumArtist,
    artist: track.artist,
    title: track.title
  });
  const matches = result.tracks
    .map((candidate) => findNavidromeCandidateMatch(track, candidate))
    .filter((match): match is NavidromeTrackMatch => Boolean(match));

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

function findNavidromeCandidateMatch(track: TrackFile, candidate: NavidromeLibraryTrack): NavidromeTrackMatch | null {
  if (candidate.sourceAbsolutePath && pathKey(candidate.sourceAbsolutePath) === pathKey(track.absolutePath)) {
    return { track: candidate, method: "absolute-path" };
  }

  if (candidate.sourceRelativePath && relativePathKey(candidate.sourceRelativePath) === relativePathKey(track.relativePath)) {
    return { track: candidate, method: "relative-path" };
  }

  if (sameNonEmptyKey(filenameSizeKey(candidate.sourceRelativePath, candidate.size), filenameSizeKey(track.relativePath, track.size))) {
    return { track: candidate, method: "filename-size" };
  }

  if (sameNonEmptyKey(navidromeMetadataKey(candidate), trackMetadataKey(track))) {
    return { track: candidate, method: "metadata-key" };
  }

  if (sameNonEmptyKey(navidromeRelaxedDurationKey(candidate), trackRelaxedDurationKey(track))) {
    return { track: candidate, method: "metadata-size-relaxed-duration" };
  }

  if (sameNonEmptyKey(navidromeEditionMetadataKey(candidate), trackEditionMetadataKey(track))) {
    return { track: candidate, method: "edition-metadata-size" };
  }

  if (sameNonEmptyKey(navidromeTitleSuffixMetadataKey(candidate), trackTitleSuffixMetadataKey(track))) {
    return { track: candidate, method: "metadata-size-title-suffix" };
  }

  if (sameNonEmptyKey(navidromeEditionTitleSuffixMetadataKey(candidate), trackEditionTitleSuffixMetadataKey(track))) {
    return { track: candidate, method: "edition-title-suffix-metadata-size" };
  }

  if (sameNonEmptyKey(navidromeTrackAgnosticMetadataKey(candidate), trackTrackAgnosticMetadataKey(track))) {
    return { track: candidate, method: "metadata-size-track-agnostic" };
  }

  if (sameNonEmptyKey(navidromeArtistAgnosticMetadataKey(candidate), trackArtistAgnosticMetadataKey(track))) {
    return { track: candidate, method: "metadata-size-artist-agnostic" };
  }

  return null;
}

function trackFileFromNavidromeTrack(
  track: TrackFile,
  navidromeTrack: NavidromeLibraryTrack,
  settings: PrivateSettings,
  matchMethod: NavidromeMetadataMatchMethod,
  indexedTrackCount: number
): TrackFile {
  const navidromeEnrichment = matchedNavidromeDiagnostic(matchMethod, indexedTrackCount);

  if (track.metadataConfidence === "spotify" || track.metadataConfidence === "trusted-path") {
    return withNavidromeDiagnostic(track, navidromeEnrichment);
  }

  const navidromeArtist = cleanDisplayValue(navidromeTrack.artist, track.artist);
  const navidromeAlbumArtist = cleanDisplayValue(
    navidromeTrack.albumArtist || navidromeTrack.artist,
    track.albumArtist || navidromeArtist
  );
  const albumArtist = preferredLatinArtistAlias(track.albumArtist || track.artist, navidromeAlbumArtist, navidromeTrack);
  const artist = preferredLatinArtistAlias(track.artist, navidromeArtist, navidromeTrack);
  const album = cleanDisplayValue(cleanNavidromeAlbumTitle(navidromeTrack.album, navidromeTrack.year), track.album);
  const title = cleanDisplayValue(
    matchMethod === "metadata-size-title-suffix" || matchMethod === "edition-title-suffix-metadata-size" ? track.title : navidromeTrack.title,
    track.title
  );
  const albumType = cleanDisplayValue(navidromeTrack.albumType, track.albumType || "Album");
  const preserveTrackSlot = matchMethod === "metadata-size-track-agnostic";
  const trackNumber = preserveTrackSlot ? track.trackNumber : navidromeTrack.trackNumber ?? track.trackNumber;
  const trackTotal = navidromeTrack.trackTotal ?? track.trackTotal;
  const discNumber = preserveTrackSlot ? track.discNumber : navidromeTrack.discNumber ?? track.discNumber;
  const discTotal = navidromeTrack.discTotal ?? track.discTotal;
  const year = navidromeTrack.year ?? track.year;
  const duration = navidromeTrack.duration ?? track.duration;
  const isrc = navidromeTrack.isrc ?? track.isrc ?? null;
  const issues = track.issues.filter((issue) => {
    if (issue === "Missing artist" && artist) {
      return false;
    }
    if (issue === "Missing album" && album) {
      return false;
    }
    if (issue === "Missing track number" && trackNumber) {
      return false;
    }
    return true;
  });
  const partialTrack = {
    ...track,
    artist,
    albumArtist,
    album,
    albumType,
    title,
    trackNumber,
    trackTotal,
    discNumber,
    discTotal,
    year,
    duration,
    isrc,
    bitrate: track.bitrate ?? navidromeTrack.bitrate,
    duplicateKey: buildDuplicateKey({
      artist: albumArtist || artist,
      album,
      albumType: albumType || "Album",
      title,
      trackNumber,
      discNumber,
      year,
      duration,
      isrc
    }),
    issues,
    navidromeEnrichment,
    metadataConfidence: "navidrome" as const,
    targetSource: "navidrome"
  } satisfies TrackFile;
  const target = targetForTrack(partialTrack, settings);

  return {
    ...partialTrack,
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
  };
}

function matchedNavidromeDiagnostic(
  matchMethod: NavidromeMetadataMatchMethod,
  indexedTrackCount: number
): NavidromeMetadataEnrichment {
  return {
    status: "matched",
    code: "matched",
    message: `Matched Navidrome metadata by ${navidromeMatchMethodLabel(matchMethod)}.`,
    matchMethod,
    indexedTrackCount
  };
}

function withNavidromeDiagnostic(track: TrackFile, navidromeEnrichment: NavidromeMetadataEnrichment): TrackFile {
  return {
    ...track,
    navidromeEnrichment
  };
}

function unmatchedNavidromeDiagnostic(track: TrackFile, indexedTrackCount: number): NavidromeMetadataEnrichment {
  const possibleStaleScan =
    track.targetRelativePath &&
    relativePathKey(track.relativePath) === relativePathKey(track.targetRelativePath);

  if (possibleStaleScan) {
    return {
      status: "unmatched",
      code: "possible-stale-scan",
      message:
        "Navidrome returned tracks, but none matched this organized local file by path, filename+size, metadata key, or metadata+size. If the file was recently moved, rescan Navidrome; otherwise inspect match details for metadata/path differences.",
      indexedTrackCount
    };
  }

  return {
    status: "unmatched",
    code: "no-api-match",
    message:
      "No Navidrome API record matched this local file by absolute path, relative path, filename+size, metadata key, or metadata+size; NaviClean used local metadata and path inference.",
    indexedTrackCount
  };
}

function navidromeMatchMethodLabel(method: NavidromeMetadataMatchMethod) {
  if (method === "absolute-path") {
    return "absolute path";
  }

  if (method === "relative-path") {
    return "relative path";
  }

  if (method === "filename-size") {
    return "filename and size";
  }

  if (method === "metadata-size-relaxed-duration") {
    return "metadata and exact size";
  }

  if (method === "edition-metadata-size") {
    return "edition-compatible metadata and size";
  }

  if (method === "metadata-size-title-suffix") {
    return "metadata and size with a compatible title suffix";
  }

  if (method === "edition-title-suffix-metadata-size") {
    return "edition-compatible metadata and size with a compatible title suffix";
  }

  if (method === "metadata-size-track-agnostic") {
    return "metadata and size without release track number";
  }

  if (method === "metadata-size-artist-agnostic") {
    return "release slot metadata and size without album artist";
  }

  return "metadata key";
}

function cleanNavidromeAlbumTitle(album: string, year: number | null) {
  if (!year) {
    return album;
  }

  return album.replace(new RegExp(`\\s*\\(${year}\\)\\s*$`), "").trim() || album;
}

function addUniqueNavidromeMatch(
  map: Map<string, NavidromeLibraryTrack | null>,
  key: string,
  track: NavidromeLibraryTrack
) {
  if (!key) {
    return;
  }

  map.set(key, map.has(key) ? null : track);
}

function uniqueNavidromeMatch(track: NavidromeLibraryTrack | null | undefined) {
  return track ?? null;
}

function pathKey(value: string) {
  return path.resolve(value).toLowerCase();
}

function relativePathKey(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function filenameSizeKey(relativePath: string | null, size: number | null) {
  if (!relativePath || !size) {
    return "";
  }

  return `${path.posix.basename(relativePath.replace(/\\/g, "/")).toLowerCase()}|${size}`;
}

function navidromeMetadataKey(track: NavidromeLibraryTrack) {
  return [
    normalizeForMatch(track.albumArtist || track.artist, { removeBracketedText: false }),
    normalizeForMatch(track.album, { removeBracketedText: false }),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber ?? "",
    durationBucket(track.duration),
    track.size ?? ""
  ].join("|");
}

function trackMetadataKey(track: TrackFile) {
  return [
    normalizeForMatch(track.albumArtist || track.artist, { removeBracketedText: false }),
    normalizeForMatch(track.album, { removeBracketedText: false }),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber ?? "",
    durationBucket(track.duration),
    track.size ?? ""
  ].join("|");
}

function navidromeRelaxedDurationKey(track: NavidromeLibraryTrack) {
  return relaxedDurationKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function trackRelaxedDurationKey(track: TrackFile) {
  return relaxedDurationKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function navidromeEditionMetadataKey(track: NavidromeLibraryTrack) {
  return editionMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function navidromeTitleSuffixMetadataKey(track: NavidromeLibraryTrack) {
  return titleSuffixMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function navidromeEditionTitleSuffixMetadataKey(track: NavidromeLibraryTrack) {
  return editionTitleSuffixMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function navidromeTrackAgnosticMetadataKey(track: NavidromeLibraryTrack) {
  return trackAgnosticMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title
  });
}

function navidromeArtistAgnosticMetadataKey(track: NavidromeLibraryTrack) {
  return artistAgnosticMetadataKey({
    album: track.album,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function trackEditionMetadataKey(track: TrackFile) {
  return editionMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function trackTitleSuffixMetadataKey(track: TrackFile) {
  return titleSuffixMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function trackEditionTitleSuffixMetadataKey(track: TrackFile) {
  return editionTitleSuffixMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber
  });
}

function relaxedDurationKey(track: {
  album: string;
  albumArtist: string;
  size: number | null;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeArtistMetadataText(track.albumArtist),
    normalizeForMatch(track.album, { removeBracketedText: false }),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function editionMetadataKey(track: {
  album: string;
  albumArtist: string;
  size: number | null;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeArtistMetadataText(track.albumArtist),
    normalizeForMatch(track.album),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function editionTitleSuffixMetadataKey(track: {
  album: string;
  albumArtist: string;
  size: number | null;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeArtistMetadataText(track.albumArtist),
    normalizeForMatch(track.album),
    normalizeForMatch(stripProviderTitleSuffix(track.title, track.albumArtist), { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function trackTrackAgnosticMetadataKey(track: TrackFile) {
  return trackAgnosticMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    size: track.size,
    title: track.title
  });
}

function trackArtistAgnosticMetadataKey(track: TrackFile) {
  return artistAgnosticMetadataKey({
    album: track.album,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function titleSuffixMetadataKey(track: {
  album: string;
  albumArtist: string;
  size: number | null;
  title: string;
  trackNumber: number | null;
  discNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeArtistMetadataText(track.albumArtist),
    normalizeForMatch(track.album, { removeBracketedText: false }),
    normalizeForMatch(stripProviderTitleSuffix(track.title, track.albumArtist), { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function trackAgnosticMetadataKey(track: {
  album: string;
  albumArtist: string;
  size: number | null;
  title: string;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.size) {
    return "";
  }

  return [
    normalizeArtistMetadataText(track.albumArtist),
    normalizeForMatch(track.album),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.size
  ].join("|");
}

function artistAgnosticMetadataKey(track: {
  album: string;
  discNumber: number | null;
  size: number | null;
  title: string;
  trackNumber: number | null;
}) {
  if (!track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeForMatch(track.album),
    normalizeForMatch(track.title, { removeBracketedText: false }),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function stripProviderTitleSuffix(value: string, albumArtist: string) {
  return value
    .replace(/\s+\(([^)]*)\)\s*$/i, (match, suffix: string, offset: number, fullValue: string) =>
      titleSuffixIsNoise(fullValue.slice(0, offset), suffix, albumArtist) ? "" : match
    )
    .trim();
}

function titleSuffixIsNoise(baseTitle: string, suffix: string, albumArtist: string) {
  const normalizedBaseTitle = normalizeForMatch(baseTitle, { removeBracketedText: false });
  const normalizedSuffix = normalizeForMatch(suffix, { removeBracketedText: false });

  if (normalizedBaseTitle && normalizedBaseTitle === normalizedSuffix) {
    return true;
  }

  if (normalizedSuffix === "single version") {
    return true;
  }

  return providerTitleSuffixIsNoise(suffix, albumArtist);
}

function providerTitleSuffixIsNoise(suffix: string, albumArtist: string) {
  const normalizedSuffix = normalizeForMatch(suffix, { removeBracketedText: false });

  if (normalizedSuffix === "pmedia") {
    return true;
  }

  const normalizedArtist = normalizeArtistMetadataText(albumArtist);
  return Boolean(
    normalizedArtist &&
      normalizedSuffix.includes(normalizedArtist) &&
      /\b(?:music|singer|artist|band|born|b\s+\d{4})\b/.test(normalizedSuffix)
  );
}

function preferredLatinArtistAlias(localValue: string, navidromeValue: string, navidromeTrack: NavidromeLibraryTrack) {
  if (
    !localValue ||
    !latinOnlyText(localValue) ||
    !containsNonLatinLetter(navidromeValue) ||
    !navidromePathContainsArtistAlias(navidromeTrack, localValue)
  ) {
    return navidromeValue;
  }

  return localValue;
}

function navidromePathContainsArtistAlias(track: NavidromeLibraryTrack, artist: string) {
  const aliasKey = pathTokenKey(artist);
  const folder = (track.sourceRelativePath || track.sourceRawPath || "").split(/[\\/]/).find(Boolean);

  if (!aliasKey || !folder) {
    return false;
  }

  return folder
    .split(/\s+(?:\u2022|\u00e2\u20ac\u00a2)\s+/u)
    .some((part) => pathTokenKey(part) === aliasKey);
}

function latinOnlyText(value: string) {
  return containsLatinLetter(value) && !containsNonLatinLetter(value);
}

function containsLatinLetter(value: string) {
  return Array.from(value).some((char) => /\p{Script=Latin}/u.test(char));
}

function containsNonLatinLetter(value: string) {
  return Array.from(value).some((char) => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char));
}

function normalizeArtistMetadataText(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false }).replace(/^the\s+/, "");
}

function sameNonEmptyKey(left: string, right: string) {
  return Boolean(left && right && left === right);
}

function durationBucket(duration: number | null) {
  return duration ? Math.round(duration / 2) * 2 : "";
}

async function collectAudioFiles(root: string, extensions: Set<string>, recycleRoot: string, onProgress?: ProgressHandler) {
  const files: string[] = [];
  const stack = [root];
  let scannedFiles = 0;

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to read ${current}: ${(error as Error).message}`);
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (
          path.resolve(absolute) === recycleRoot ||
          entry.name === ".naviclean" ||
          entry.name === ".naviclean-trash"
        ) {
          continue;
        }
        stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      }

      if (scannedFiles % 50 === 0) {
        onProgress?.({ scannedFiles });
      }
    }
  }

  onProgress?.({ scannedFiles });
  return files;
}

async function readTrack(
  filePath: string,
  root: string,
  settings: PrivateSettings,
  metadataOverrides: Map<string, MetadataOverride>
): Promise<TrackFile> {
  const stat = await fs.stat(filePath);
  const metadataOverride = validMetadataOverride(metadataOverrides, filePath, stat.size);
  const extension = path.extname(filePath).toLowerCase();
  const relativePath = toPosixRelative(root, filePath);
  const inferred = inferMetadataFromPath(relativePath);
  const issues: string[] = [];
  let metadata: Awaited<ReturnType<typeof parseFile>> | null = null;

  try {
    metadata = await parseFile(filePath, { duration: true });
  } catch (error) {
    issues.push(`Metadata read failed: ${(error as Error).message}`);
  }

  const common = metadata?.common;
  const commonRecord = common as Record<string, unknown> | undefined;
  const format = metadata?.format;
  const commonArtist = knownMetadataValue(common?.artist) || knownMetadataValue(common?.artists?.[0]);
  const commonAlbumArtist = knownMetadataValue(common?.albumartist);
  const commonAlbum = knownMetadataValue(common?.album);
  const commonTitle = knownMetadataValue(common?.title);
  const commonTrackNumber = common?.track?.no || null;
  const metadataYear = typeof common?.year === "number" && Number.isFinite(common.year) ? common.year : null;
  const commonYear = metadataYear ?? parseYear(firstCommonString(commonRecord, ["date", "originaldate", "releasedate"]));
  const hasPlaceholderIdentityTag = [common?.artist, common?.artists?.[0], common?.albumartist, common?.album].some(
    isUnknownMetadataValue
  );
  const structuredPathIdentityReason = structuredPathIdentityReasonForTags(inferred, {
    album: commonAlbum,
    albumArtist: commonAlbumArtist || commonArtist,
    artist: commonArtist,
    hasPlaceholderIdentityTag,
    title: commonTitle,
    trackNumber: commonTrackNumber,
    year: commonYear
  });

  if (!metadataOverride && structuredPathIdentityReason === "placeholder-tags") {
    issues.push("Embedded metadata used unknown placeholders; used structured path metadata");
  } else if (!metadataOverride && structuredPathIdentityReason === "conflicting-tags") {
    issues.push("Embedded metadata conflicted with structured path; used structured path metadata");
  }

  const useStructuredPathIdentity = Boolean(structuredPathIdentityReason);
  const pathIdentityNeedsReview = Boolean(
    !metadataOverride &&
    (structuredPathIdentityReason || ((!commonArtist || !commonAlbum) && (inferred.artist || inferred.album)))
  );
  if (pathIdentityNeedsReview) {
    issues.push("Path-derived artist or album requires metadata review");
  }
  const inferredArtist = cleanDisplayText(
    (useStructuredPathIdentity ? inferred.artist : commonArtist || inferred.artist),
    "Unknown Artist",
    "artist",
    issues
  );
  const artist = metadataOverride?.metadata.artist ?? inferredArtist;
  const inferredAlbumArtist = cleanDisplayText(
    (useStructuredPathIdentity
      ? inferred.albumArtist || inferred.artist
      : commonAlbumArtist || commonArtist || inferred.albumArtist || inferred.artist),
    artist,
    "album artist",
    issues
  );
  const albumArtist = metadataOverride?.metadata.albumArtist ?? inferredAlbumArtist;
  const inferredAlbum = cleanDisplayText(
    (useStructuredPathIdentity ? inferred.album : commonAlbum || inferred.album),
    "Unknown Album",
    "album",
    issues
  );
  const album = metadataOverride?.metadata.album ?? inferredAlbum;
  const inferredTitle = cleanDisplayText(
    (useStructuredPathIdentity ? inferred.title : commonTitle || inferred.title),
    titleFromFilename(filePath),
    "title",
    issues
  );
  const title = metadataOverride?.metadata.title ?? inferredTitle;
  const inferredTrackNumber = (useStructuredPathIdentity ? inferred.trackNumber : commonTrackNumber || inferred.trackNumber) || null;
  const trackNumber = metadataOverride?.metadata.trackNumber ?? inferredTrackNumber;
  const trackTotal = metadataOverride?.metadata.trackTotal ?? common?.track?.of ?? null;
  const inferredDiscNumber = common?.disk?.no || inferred.discNumber || null;
  const discNumber = metadataOverride?.metadata.discNumber ?? inferredDiscNumber;
  const discTotal = metadataOverride?.metadata.discTotal ?? common?.disk?.of ?? null;
  const inferredYear = (useStructuredPathIdentity ? inferred.year : commonYear ?? inferred.year) ?? null;
  const year = metadataOverride?.metadata.year ?? inferredYear;
  const inferredAlbumType = normalizeAlbumType(firstCommonString(commonRecord, ["albumtype", "releasetype", "release_type"]) || inferred.albumType, trackTotal);
  const albumType = metadataOverride?.metadata.albumType ?? inferredAlbumType;
  const duration = typeof format?.duration === "number" ? format.duration : null;
  const isrc = metadataOverride?.metadata.isrc ?? common?.isrc?.[0] ?? null;
  const bitrate = typeof format?.bitrate === "number" ? Math.round(format.bitrate) : null;
  const sampleRate = typeof format?.sampleRate === "number" ? format.sampleRate : null;
  const bitsPerSample = typeof format?.bitsPerSample === "number" ? format.bitsPerSample : null;
  const codec = cleanNullable(format?.codec);
  const container = cleanNullable(format?.container);
  const lossless = Boolean(format?.lossless || [".flac", ".alac", ".wav", ".aiff", ".aif"].includes(extension));
  const managedBy = hasTrackKeepIdentityTags({
    common: metadata?.common as Record<string, unknown> | undefined,
    native: metadata?.native
  }) ? "trackkeep" : undefined;

  if (artist === "Unknown Artist") {
    issues.push("Missing artist");
  }
  if (album === "Unknown Album") {
    issues.push("Missing album");
  }
  if (!trackNumber) {
    issues.push("Missing track number");
  }

  const partialTrack = {
    id: fileId(filePath, stat.size, stat.mtimeMs),
    absolutePath: filePath,
    relativePath,
    extension,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    artist,
    albumArtist,
    album,
    albumType,
    title,
    trackNumber,
    trackTotal,
    discNumber,
    discTotal,
    year,
    duration,
    isrc,
    bitrate,
    sampleRate,
    bitsPerSample,
    codec,
    container,
    lossless,
    duplicateKey: buildDuplicateKey({
      artist: albumArtist || artist,
      album,
      albumType,
      title,
      trackNumber,
      discNumber,
      year,
      duration,
      isrc
    }),
    qualityScore: qualityScore(extension, bitrate, bitsPerSample, lossless),
    targetPath: "",
    targetRelativePath: "",
    targetSource: metadataOverride?.source === "spotify" ? "spotify" : undefined,
    metadataConfidence: metadataOverride?.source ?? (pathIdentityNeedsReview ? "path-suggestion" : "embedded"),
    metadataSuggestion: pathIdentityNeedsReview
      ? {
          artist: inferred.artist ?? null,
          albumArtist: inferred.albumArtist ?? inferred.artist ?? null,
          album: inferred.album ?? null,
          title: inferred.title ?? null,
          trackNumber: inferred.trackNumber ?? null,
          discNumber: inferred.discNumber ?? null,
          year: inferred.year ?? null
        }
      : undefined,
    managedBy,
    issues
  } satisfies TrackFile;

  const target = targetForTrack(partialTrack, settings);
  return {
    ...partialTrack,
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
  };
}

function qualityScore(extension: string, bitrate: number | null, bitsPerSample: number | null, lossless: boolean) {
  const base = extensionQuality[extension] || 100;
  const bitrateBonus = bitrate ? Math.min(240, Math.round(bitrate / 1000)) : 0;
  const bitDepthBonus = bitsPerSample ? bitsPerSample * 4 : 0;
  return base + bitrateBonus + bitDepthBonus + (lossless ? 100 : 0);
}

function fileId(filePath: string, size: number, mtimeMs: number) {
  return sha1(`${filePath}:${size}:${Math.round(mtimeMs)}`);
}

function cleanNullable(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanDisplayText(value: unknown, fallback: string, field: string, issues: string[]) {
  const displayValue = cleanDisplayValue(value, fallback);
  const repaired = repairUtf16MojibakeText(displayValue);

  if (repaired && repaired !== displayValue) {
    issues.push(`Repaired corrupted text encoding in ${field}`);
    return repaired;
  }

  return displayValue;
}

type InferredMetadata = {
  album?: string;
  albumArtist?: string;
  albumType?: string;
  artist?: string;
  discNumber?: number;
  structuredPath?: boolean;
  title?: string;
  trackNumber?: number;
  year?: number;
};

function inferMetadataFromPath(relativePath: string): InferredMetadata {
  const parsedPath = path.posix.parse(relativePath);
  const folderSegments = parsedPath.dir.split("/").filter(Boolean);
  const folderName = folderSegments.at(-1);
  const parentArtistFolderName = folderSegments.at(-2);
  const structuredFolder = parseStructuredAlbumDirectory(parsedPath.dir);
  const artistAlbumFolder = folderName?.match(/^(?<artist>.+?)\s+-\s+(?<album>.+)$/);
  const rawAlbumArtist =
    structuredFolder?.artist ??
    artistAlbumFolder?.groups?.artist?.trim() ??
    (folderName && parentArtistFolderName ? parentArtistFolderName : undefined);
  const rawAlbum =
    structuredFolder?.album ??
    artistAlbumFolder?.groups?.album?.trim() ??
    (folderName && parentArtistFolderName ? folderName : undefined);
  const albumArtist = knownMetadataValue(rawAlbumArtist);
  const album = knownMetadataValue(rawAlbum);
  const hasFolderIdentity = Boolean((structuredFolder || artistAlbumFolder || (folderName && parentArtistFolderName)) && (albumArtist || album));
  const filename = inferMetadataFromFilename(parsedPath.name, !hasFolderIdentity);
  const structuredFilename = inferStructuredTrackFilename(
    parsedPath.name,
    rawAlbumArtist,
    rawAlbum,
    structuredFolder?.year
  );
  const structuredArtist = knownMetadataValue(structuredFilename.artist);
  const structuredAlbumArtist = knownMetadataValue(structuredFilename.albumArtist || structuredFilename.artist);
  const structuredAlbum = knownMetadataValue(structuredFilename.album);
  const structuredPath = hasCompleteStructuredPathIdentity(structuredFilename);

  return {
    album: album ?? structuredAlbum ?? knownMetadataValue(filename.album),
    albumArtist: albumArtist ?? structuredAlbumArtist ?? knownMetadataValue(filename.artist),
    albumType: structuredFolder?.albumType,
    artist: structuredArtist ?? knownMetadataValue(filename.artist) ?? albumArtist ?? structuredAlbumArtist,
    discNumber: structuredFilename.discNumber ?? filename.discNumber,
    structuredPath,
    title: structuredFilename.title ?? filename.title,
    trackNumber: structuredFilename.trackNumber ?? filename.trackNumber,
    year: structuredFolder?.year ?? structuredFilename.year ?? undefined
  };
}

function hasCompleteStructuredPathIdentity(value: InferredMetadata) {
  return Boolean(value.artist && value.album && value.title && value.trackNumber);
}

function structuredPathIdentityReasonForTags(
  inferred: InferredMetadata,
  tags: {
    album?: string;
    albumArtist?: string;
    artist?: string;
    hasPlaceholderIdentityTag: boolean;
    title?: string;
    trackNumber: number | null;
    year: number | null;
  }
): StructuredPathIdentityReason | null {
  if (!inferred.structuredPath || !hasCompleteStructuredPathIdentity(inferred)) {
    return null;
  }

  if (!tags.artist || !tags.album) {
    return tags.hasPlaceholderIdentityTag ? "placeholder-tags" : "missing-tags";
  }

  const albumArtist = tags.albumArtist || tags.artist;
  const conflicts = [
    metadataTextDiffers(inferred.albumArtist || inferred.artist || "", albumArtist),
    metadataTextDiffers(inferred.album || "", tags.album),
    Boolean(tags.title && metadataTextDiffers(inferred.title || "", tags.title)),
    Boolean(tags.trackNumber && inferred.trackNumber && tags.trackNumber !== inferred.trackNumber),
    Boolean(tags.year && inferred.year && tags.year !== inferred.year)
  ].filter(Boolean).length;

  if (tags.title && hasMeaningfulPathTitleVersion(inferred.title || "", tags.title, inferred.albumArtist || inferred.artist || albumArtist)) {
    return "conflicting-tags";
  }

  return conflicts >= 3 ? "conflicting-tags" : null;
}

function inferStructuredTrackFilename(
  value: string,
  albumArtist?: string,
  album?: string,
  year?: number | null
): InferredMetadata {
  const parsed = parseStandardTrackFilename(value);

  if (parsed?.artist && parsed.album) {
    const expectedYear = typeof year === "number" ? String(year) : undefined;
    const artistMatches = !albumArtist || samePathToken(parsed.artist, albumArtist);
    const albumMatches = !album || samePathToken(parsed.album, album);
    const yearMatches = !expectedYear || parsed.year === year;

    if (artistMatches && albumMatches && yearMatches) {
      const nested = parseStandardTrackFilename(parsed.title ?? "");

      if (nested && isUnknownMetadataValue(parsed.artist) && isUnknownMetadataValue(parsed.album)) {
        return nested;
      }

      return parsed;
    }
  }

  return {};
}

function parseStandardTrackFilename(value: string): InferredMetadata | null {
  const standardMatch = value.match(
    /^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)\s+-\s+(?:(?<medium>\d{1,2})[-_.](?<mediumTrack>\d{1,3})|(?<track>\d{1,3}))\s+-\s+(?<title>.+)$/
  );

  if (!standardMatch?.groups) {
    return null;
  }

  const artist = standardMatch.groups.artist.trim();

  return {
    album: standardMatch.groups.album.trim(),
    albumArtist: artist,
    artist,
    discNumber: parsePositiveInteger(standardMatch.groups.medium),
    title: standardMatch.groups.title.trim(),
    trackNumber: parsePositiveInteger(standardMatch.groups.mediumTrack || standardMatch.groups.track),
    year: parseYear(standardMatch.groups.year) ?? undefined
  };
}

function inferMetadataFromFilename(value: string, allowIdentityFromName: boolean): InferredMetadata {
  const trackNumbers = inferTrackNumbersFromFileName(value);
  const cleaned = cleanTrackFileName(value);

  if (!allowIdentityFromName) {
    return {
      title: cleaned,
      ...trackNumbers
    };
  }

  const artistAlbumTitleMatch = cleaned.match(/^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+-\s+(?<title>.+)$/);

  if (artistAlbumTitleMatch?.groups) {
    return {
      artist: artistAlbumTitleMatch.groups.artist.trim(),
      album: artistAlbumTitleMatch.groups.album.trim(),
      title: artistAlbumTitleMatch.groups.title.trim(),
      ...trackNumbers
    };
  }

  const artistTitleMatch = cleaned.match(/^(?<artist>.+?)\s+-\s+(?<title>.+)$/);

  if (artistTitleMatch?.groups) {
    return {
      artist: artistTitleMatch.groups.artist.trim(),
      title: artistTitleMatch.groups.title.trim(),
      ...trackNumbers
    };
  }

  return {
    title: cleaned,
    ...trackNumbers
  };
}

function cleanTrackFileName(value: string) {
  return (
    value
      .replace(/^\s*\d{4}\s*[-_. ]+\s*/, "")
      .replace(/^\s*\d{1,2}[-_.]\d{1,2}\s*[-_. ]+\s*/, "")
      .replace(/^\s*\d{1,3}\s*[-_. ]+\s*/, "")
      .replace(/\s+/g, " ")
      .trim() || value
  );
}

function inferTrackNumbersFromFileName(value: string) {
  const combinedDiscTrackMatch = value.match(/^\s*(?<medium>\d{2})(?<track>\d{2})\s*[-_. ]+/);

  if (combinedDiscTrackMatch?.groups) {
    return {
      discNumber: parsePositiveInteger(combinedDiscTrackMatch.groups.medium),
      trackNumber: parsePositiveInteger(combinedDiscTrackMatch.groups.track)
    };
  }

  const multiDiscMatch = value.match(/^\s*(?<medium>\d{1,2})[-_.](?<track>\d{1,2})\s*[-_. ]+/);

  if (multiDiscMatch?.groups) {
    return {
      discNumber: parsePositiveInteger(multiDiscMatch.groups.medium),
      trackNumber: parsePositiveInteger(multiDiscMatch.groups.track)
    };
  }

  const trackMatch = value.match(/^\s*(?<track>\d{1,3})\s*[-_. ]+/);

  return {
    discNumber: undefined,
    trackNumber: parsePositiveInteger(trackMatch?.groups?.track)
  };
}

function parseStructuredAlbumDirectory(relativeDirectory: string) {
  const segments = relativeDirectory.split("/").filter(Boolean);
  const albumFolderName = segments.at(-1);
  const parentArtistFolderName = segments.at(-2);

  if (!albumFolderName || !parentArtistFolderName) {
    return null;
  }

  const prefix = `${parentArtistFolderName} - `;

  if (!albumFolderName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return parseStructuredAlbumFolderWithArtist(albumFolderName, parentArtistFolderName);
  }

  const remainder = albumFolderName.slice(prefix.length);
  const standardMatch = remainder.match(/^(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)$/);

  if (standardMatch?.groups) {
    return {
      album: standardMatch.groups.album.trim(),
      artist: parentArtistFolderName.trim(),
      year: parseYear(standardMatch.groups.year)
    };
  }

  const yearAlbumMatch = remainder.match(/^(?<year>\d{4}|Unknown Year) - (?<album>.+)$/);

  if (yearAlbumMatch?.groups) {
    return {
      album: yearAlbumMatch.groups.album.trim(),
      artist: parentArtistFolderName.trim(),
      year: parseYear(yearAlbumMatch.groups.year)
    };
  }

  const match = remainder.match(/^(?<albumType>.+?) - (?<year>\d{4}|Unknown Year) - (?<album>.+)$/);

  if (!match?.groups) {
    return null;
  }

  return {
    album: match.groups.album.trim(),
    albumType: normalizeAlbumType(match.groups.albumType),
    artist: parentArtistFolderName.trim(),
    year: parseYear(match.groups.year)
  };
}

function parseStructuredAlbumFolderWithArtist(albumFolderName: string, parentArtistFolderName: string) {
  const standardMatch = albumFolderName.match(
    /^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)$/
  );

  if (standardMatch?.groups && samePathToken(standardMatch.groups.artist, parentArtistFolderName)) {
    return {
      album: standardMatch.groups.album.trim(),
      artist: standardMatch.groups.artist.trim(),
      year: parseYear(standardMatch.groups.year)
    };
  }

  const legacyMatch = albumFolderName.match(
    /^(?<artist>.+?)\s+-\s+(?:(?<albumType>.+?)\s+-\s+)?(?<year>\d{4}|Unknown Year)\s+-\s+(?<album>.+)$/
  );

  if (!legacyMatch?.groups || !samePathToken(legacyMatch.groups.artist, parentArtistFolderName)) {
    return null;
  }

  return {
    album: legacyMatch.groups.album.trim(),
    albumType: normalizeAlbumType(legacyMatch.groups.albumType),
    artist: legacyMatch.groups.artist.trim(),
    year: parseYear(legacyMatch.groups.year)
  };
}

function samePathToken(left: string, right: string) {
  return pathTokenKey(left) === pathTokenKey(right);
}

function pathTokenKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function firstCommonString(common: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = common?.[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }

  return undefined;
}

function parseYear(value: string | undefined) {
  const match = value?.match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : null;
}

function parsePositiveInteger(value?: string) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value.split("/")[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeAlbumType(value?: string, trackTotal?: number | null) {
  const albumType = (value || "").trim().toLowerCase();

  if (albumType === "compilation") {
    return "Compilation";
  }

  if (albumType === "single") {
    return typeof trackTotal === "number" && trackTotal >= 4 && trackTotal <= 7 ? "EP" : "Single";
  }

  if (albumType === "ep") {
    return "EP";
  }

  return albumType ? titleCaseAlbumType(albumType) : "";
}

function knownMetadataValue(value: unknown) {
  return typeof value === "string" && value.trim() && !isUnknownMetadataValue(value) ? value.trim() : undefined;
}

function isUnknownMetadataValue(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = normalizeForMatch(value, { removeBracketedText: false })
    .replace(/\b(?:\d{4}|unknown year)\b/g, "")
    .trim();

  return !normalized || normalized === "unknown artist" || normalized === "unknown album" || normalized === "unknown track";
}

function metadataTextDiffers(left: string, right: string) {
  return normalizeForMatch(left, { removeBracketedText: false }) !== normalizeForMatch(right, { removeBracketedText: false });
}

function hasMeaningfulPathTitleVersion(pathTitle: string, tagTitle: string, albumArtist: string) {
  const match = pathTitle.match(/^(?<base>.+?)\s+\((?<suffix>[^)]*)\)\s*$/);

  if (!match?.groups) {
    return false;
  }

  return (
    normalizeForMatch(match.groups.base, { removeBracketedText: false }) ===
      normalizeForMatch(tagTitle, { removeBracketedText: false }) &&
    !titleSuffixIsNoise(match.groups.base, match.groups.suffix, albumArtist)
  );
}

function titleCaseAlbumType(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
