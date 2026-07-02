import { parseFile } from "music-metadata";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NavidromeMetadataEnrichment, NavidromeMetadataMatchMethod, ScanStatus, TrackFile } from "../shared/types.js";
import { saveCatalog } from "./catalog.js";
import { buildDuplicateKey } from "./matching.js";
import { fetchNavidromeLibraryTracks, type NavidromeLibraryTrack } from "./navidrome.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { hasSpotifyBuIdentityTags } from "./spotifybu.js";
import { cleanDisplayValue, normalizeForMatch, sha1, titleFromFilename, toPosixRelative } from "./utils.js";

export { hasSpotifyBuIdentityTags };

type ProgressHandler = (status: Partial<ScanStatus>) => void;
type ParsedAudioMetadata = Awaited<ReturnType<typeof parseFile>>;

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

  for (const filePath of files) {
    try {
      const track = await readTrack(filePath, root, settings);
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

  await saveCatalog(navidromeEnriched.tracks);
  return { tracks: navidromeEnriched.tracks, errors, warnings };
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
  const unmatchedExamples: string[] = [];
  const enrichedTracks = tracks.map((track) => {
    const navidromeMatch = findNavidromeTrackForFile(index, track);

    if (!navidromeMatch) {
      if (unmatchedExamples.length < 5) {
        unmatchedExamples.push(track.relativePath);
      }
      return withNavidromeDiagnostic(track, unmatchedNavidromeDiagnostic(track, navidromeTracks.length));
    }

    matched += 1;
    return trackFileFromNavidromeTrack(track, navidromeMatch.track, settings, navidromeMatch.method, navidromeTracks.length);
  });
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
      `Navidrome metadata: ${noApiMatchCount.toLocaleString()} local files did not match any Navidrome API record by absolute path, relative path, filename+size, or metadata key.`
    );
  }

  if (possibleStaleScanCount > 0) {
    warnings.push(
      `Navidrome metadata: ${possibleStaleScanCount.toLocaleString()} organized local files may need a fresh Navidrome scan; no matching API path or metadata record was returned.`
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
    byMetadata: new Map()
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

  return null;
}

function trackFileFromNavidromeTrack(
  track: TrackFile,
  navidromeTrack: NavidromeLibraryTrack,
  settings: PrivateSettings,
  matchMethod: NavidromeMetadataMatchMethod,
  indexedTrackCount: number
): TrackFile {
  const artist = cleanDisplayValue(navidromeTrack.artist, track.artist);
  const albumArtist = cleanDisplayValue(navidromeTrack.albumArtist || navidromeTrack.artist, track.albumArtist || artist);
  const album = cleanDisplayValue(navidromeTrack.album, track.album);
  const title = cleanDisplayValue(navidromeTrack.title, track.title);
  const albumType = cleanDisplayValue(navidromeTrack.albumType, track.albumType || "Album");
  const trackNumber = navidromeTrack.trackNumber ?? track.trackNumber;
  const trackTotal = navidromeTrack.trackTotal ?? track.trackTotal;
  const discNumber = navidromeTrack.discNumber ?? track.discNumber;
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
    navidromeEnrichment: {
      status: "matched",
      code: "matched",
      message: `Matched Navidrome metadata by ${navidromeMatchMethodLabel(matchMethod)}.`,
      matchMethod,
      indexedTrackCount
    },
    targetSource: "navidrome"
  } satisfies TrackFile;
  const target = targetForTrack(partialTrack, settings);

  return {
    ...partialTrack,
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
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
        "Navidrome returned tracks, but none matched this organized local file by path, filename+size, or metadata key. A fresh Navidrome scan may be needed.",
      indexedTrackCount
    };
  }

  return {
    status: "unmatched",
    code: "no-api-match",
    message:
      "No Navidrome API record matched this local file by absolute path, relative path, filename+size, or metadata key; NaviClean used local metadata and path inference.",
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

  return "metadata key";
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

async function readTrack(filePath: string, root: string, settings: PrivateSettings): Promise<TrackFile> {
  const stat = await fs.stat(filePath);
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
  const artist = cleanDisplayValue(common?.artist || common?.artists?.[0] || inferred.artist, "Unknown Artist");
  const albumArtist = cleanDisplayValue(
    common?.albumartist || common?.artist || common?.artists?.[0] || inferred.albumArtist || inferred.artist,
    artist
  );
  const album = cleanDisplayValue(common?.album || inferred.album, "Unknown Album");
  const title = cleanDisplayValue(common?.title || inferred.title, titleFromFilename(filePath));
  const trackNumber = common?.track?.no || inferred.trackNumber || null;
  const trackTotal = common?.track?.of || null;
  const discNumber = common?.disk?.no || inferred.discNumber || null;
  const discTotal = common?.disk?.of || null;
  const metadataYear = typeof common?.year === "number" && Number.isFinite(common.year) ? common.year : null;
  const year = metadataYear ?? parseYear(firstCommonString(commonRecord, ["date", "originaldate", "releasedate"])) ?? inferred.year ?? null;
  const albumType = normalizeAlbumType(firstCommonString(commonRecord, ["albumtype", "releasetype", "release_type"]) || inferred.albumType, trackTotal);
  const duration = typeof format?.duration === "number" ? format.duration : null;
  const isrc = common?.isrc?.[0] || null;
  const bitrate = typeof format?.bitrate === "number" ? Math.round(format.bitrate) : null;
  const sampleRate = typeof format?.sampleRate === "number" ? format.sampleRate : null;
  const bitsPerSample = typeof format?.bitsPerSample === "number" ? format.bitsPerSample : null;
  const codec = cleanNullable(format?.codec);
  const container = cleanNullable(format?.container);
  const lossless = Boolean(format?.lossless || [".flac", ".alac", ".wav", ".aiff", ".aif"].includes(extension));
  const managedBy = hasSpotifyBuIdentityTags({
    common: metadata?.common as Record<string, unknown> | undefined,
    native: metadata?.native
  }) ? "spotifybu" : undefined;

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

type InferredMetadata = {
  album?: string;
  albumArtist?: string;
  albumType?: string;
  artist?: string;
  discNumber?: number;
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
  const hasFolderIdentity = Boolean(structuredFolder || artistAlbumFolder || (folderName && parentArtistFolderName));
  const albumArtist =
    structuredFolder?.artist ??
    artistAlbumFolder?.groups?.artist?.trim() ??
    (folderName && parentArtistFolderName ? parentArtistFolderName : undefined);
  const album =
    structuredFolder?.album ??
    artistAlbumFolder?.groups?.album?.trim() ??
    (folderName && parentArtistFolderName ? folderName : undefined);
  const filename = inferMetadataFromFilename(parsedPath.name, !hasFolderIdentity);
  const structuredFilename = inferStructuredTrackFilename(
    parsedPath.name,
    albumArtist,
    album,
    structuredFolder?.year
  );

  return {
    album: album ?? filename.album,
    albumArtist: albumArtist ?? filename.artist,
    albumType: structuredFolder?.albumType,
    artist: filename.artist ?? albumArtist,
    discNumber: structuredFilename.discNumber ?? filename.discNumber,
    title: structuredFilename.title ?? filename.title,
    trackNumber: structuredFilename.trackNumber ?? filename.trackNumber,
    year: structuredFolder?.year ?? undefined
  };
}

function inferStructuredTrackFilename(
  value: string,
  albumArtist?: string,
  album?: string,
  year?: number | null
): InferredMetadata {
  const standardMatch = value.match(
    /^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)\s+-\s+(?:(?<medium>\d{1,2})[-_.](?<mediumTrack>\d{1,3})|(?<track>\d{1,3}))\s+-\s+(?<title>.+)$/
  );

  if (standardMatch?.groups) {
    const expectedYear = typeof year === "number" ? String(year) : undefined;
    const filenameYear = standardMatch.groups.year;
    const artistMatches = !albumArtist || samePathToken(standardMatch.groups.artist, albumArtist);
    const albumMatches = !album || samePathToken(standardMatch.groups.album, album);
    const yearMatches = !expectedYear || filenameYear === expectedYear;

    if (artistMatches && albumMatches && yearMatches) {
      return {
        discNumber: parsePositiveInteger(standardMatch.groups.medium),
        title: standardMatch.groups.title.trim(),
        trackNumber: parsePositiveInteger(standardMatch.groups.mediumTrack || standardMatch.groups.track)
      };
    }
  }

  return {};
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

function titleCaseAlbumType(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
