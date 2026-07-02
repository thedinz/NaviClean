import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CatalogProviderCandidate,
  CatalogProviderCandidateScore,
  CatalogProviderId,
  SpotifyAlbumDetail,
  SpotifyCatalogDownloadJob,
  SpotifyCatalogDownloadJobItem,
  SpotifyCatalogDownloadPreviewItem,
  SpotifyCatalogDownloadPreviewResult,
  SpotifyTrackSummary,
  TrackFile
} from "../shared/types.js";
import { buildDuplicateKey } from "./matching.js";
import { targetForTrack } from "./organizer.js";
import { scanLibrary } from "./scanner.js";
import type { PrivateSettings } from "./settings.js";
import { spotifyBuMetadataTagsForSpotifyTrack } from "./spotifybu.js";
import { normalizeForMatch, sha1, toPosixRelative } from "./utils.js";
import { buildSpotifyDownloadPlan } from "./spotify.js";

type CatalogProviderTrack = {
  album: string;
  albumId: string;
  albumArtist: string;
  albumImageUrl: string | null;
  albumReleaseYear: number | null;
  albumSpotifyUrl: string;
  albumTracksTotal: number;
  albumType: string;
  artists: string[];
  discNumber: number;
  durationMs: number;
  id: string;
  name: string;
  spotifyUrl: string;
  trackNumber: number;
};

type YtDlpSearchEntry = {
  channel?: string;
  duration?: number;
  id?: string;
  title?: string;
  uploader?: string;
  url?: string;
  webpage_url?: string;
};

type YtDlpSearchResult = {
  entries?: YtDlpSearchEntry[];
};

type JioSaavnAutocompleteResponse = {
  songs?: {
    data?: JioSaavnSongEntry[];
  };
};

type JioSaavnSongEntry = {
  duration?: string;
  id?: string;
  more_info?: {
    album?: string;
    duration?: string;
    primary_artists?: string;
    singers?: string;
  };
  perma_url?: string;
  subtitle?: string;
  title?: string;
  url?: string;
};

type ExecFileError = Error & {
  code?: number | string;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

type ProviderDownloadResult = {
  bytesWritten: number;
  destinationPath: string;
  relativePath: string;
};

type ProviderDownloadLog = {
  downloads: Array<{
    album: string;
    artists: string[];
    bytesWritten: number;
    confirmedAt: string;
    destinationPath: string;
    providerId: CatalogProviderId;
    relativePath: string;
    sourceUrl: string;
    trackId: string;
    trackName: string;
  }>;
  updatedAt: string;
  version: 1;
};

const execFileAsync = promisify(execFile);
const providerIds: CatalogProviderId[] = ["youtube", "jiosaavn"];
const maxBatchItems = 100;
const maxPreviewConcurrency = 3;
const minYoutubeSearchResultsPerQuery = 5;
const maxYoutubeSearchResultsPerQuery = 20;
const defaultProviderSearchTimeoutMs = 20_000;
const defaultProviderDownloadTimeoutMs = 600_000;
const confidentYoutubeCandidateScore = 94;
const stagingRootSegments = [".naviclean", "tmp", "provider-downloads"];
const provenanceLogSegments = [".naviclean", "provider-downloads.json"];
const defaultYtDlpJsRuntime = "node";
const jobs = new Map<string, SpotifyCatalogDownloadJob>();

export async function previewSpotifyCatalogDownloads(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string,
  trackIds?: string[]
): Promise<SpotifyCatalogDownloadPreviewResult> {
  const plan = await buildSpotifyDownloadPlan(settings, localTracks, albumId, trackIds);
  const selectedTracks = plan.selectedTracks.slice(0, maxBatchItems);
  const items = await mapWithConcurrency(
    selectedTracks,
    Math.min(settings.catalog.providers.maxConcurrentDownloads, maxPreviewConcurrency),
    async (track) => previewDownloadItem(settings, plan.album, track)
  );
  const downloadableCount = items.filter((item) => item.selectedCandidate?.url).length;

  return {
    album: plan.album,
    downloadableCount,
    failedCount: items.length - downloadableCount,
    generatedAt: new Date().toISOString(),
    items,
    warnings: [
      ...plan.warnings,
      "YouTube and JioSaavn searches are rate-limited and can be blocked by their providers. Keep bulk downloads small."
    ]
  };
}

export async function startSpotifyCatalogDownloadJob({
  albumId,
  bulkRiskAccepted,
  localTracks,
  rightsConfirmed,
  settings,
  trackIds
}: {
  albumId: string;
  bulkRiskAccepted: boolean;
  localTracks: TrackFile[];
  rightsConfirmed: boolean;
  settings: PrivateSettings;
  trackIds?: string[];
}) {
  if (!rightsConfirmed) {
    throw new Error("Confirm you are authorized to download the selected tracks first.");
  }

  if (!bulkRiskAccepted) {
    throw new Error("Accept the provider and bulk-download risk warning first.");
  }

  const preview = await previewSpotifyCatalogDownloads(settings, localTracks, albumId, trackIds);
  const now = new Date().toISOString();
  const job: SpotifyCatalogDownloadJob = {
    completedCount: 0,
    createdAt: now,
    failedCount: 0,
    id: providerJobId(),
    items: preview.items.map((item) => ({
      candidate: item.selectedCandidate,
      error: item.selectedCandidate ? undefined : item.error ?? "No provider candidate was found.",
      status: item.selectedCandidate ? "pending" : "failed",
      targetRelativePath: item.targetRelativePath,
      track: item.track
    })),
    pendingCount: preview.items.filter((item) => item.selectedCandidate).length,
    status: "queued",
    totalCount: preview.items.length,
    updatedAt: now
  };

  updateJobCounts(job);
  jobs.set(job.id, job);
  setTimeout(() => {
    void runDownloadJob(settings, preview.album, job.id);
  }, 0);

  return {
    job: snapshotJob(job),
    preview
  };
}

export function getSpotifyCatalogDownloadJob(jobId: string) {
  const job = jobs.get(jobId);
  return job ? snapshotJob(job) : null;
}

async function previewDownloadItem(
  settings: PrivateSettings,
  album: SpotifyAlbumDetail,
  track: SpotifyTrackSummary
): Promise<SpotifyCatalogDownloadPreviewItem> {
  const providerTrack = providerTrackFromSpotify(album, track);
  const targetRelativePath = targetRelativePathForTrack(settings, providerTrack);

  try {
    const candidates = await searchProviderCandidates(providerTrack, 5);

    return {
      candidates,
      selectedCandidate: candidates[0] ?? null,
      targetRelativePath,
      track
    };
  } catch (error) {
    return {
      candidates: [],
      error: errorMessage(error),
      selectedCandidate: null,
      targetRelativePath,
      track
    };
  }
}

async function runDownloadJob(
  settings: PrivateSettings,
  album: SpotifyAlbumDetail,
  jobId: string
) {
  const job = jobs.get(jobId);

  if (!job || job.status === "running") {
    return;
  }

  const activeJob = job;

  activeJob.status = "running";
  activeJob.updatedAt = new Date().toISOString();
  updateJobCounts(activeJob);

  const downloadableItems = activeJob.items.filter((item) => item.status === "pending" && item.candidate);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < downloadableItems.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = downloadableItems[index];

      if (item) {
        await runDownloadJobItem(settings, album, activeJob, item);
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(settings.catalog.providers.maxConcurrentDownloads, downloadableItems.length || 1)
      },
      () => worker()
    )
  );

  updateJobCounts(activeJob);
  activeJob.status = activeJob.failedCount === activeJob.totalCount ? "failed" : "completed";
  activeJob.completedAt = new Date().toISOString();
  activeJob.updatedAt = activeJob.completedAt;

  try {
    await scanLibrary(settings);
  } catch (error) {
    console.warn("[naviclean.provider-download] post-download scan failed", {
      error: errorMessage(error),
      jobId
    });
  }
}

async function runDownloadJobItem(
  settings: PrivateSettings,
  album: SpotifyAlbumDetail,
  job: SpotifyCatalogDownloadJob,
  item: SpotifyCatalogDownloadJobItem
) {
  const candidate = item.candidate;

  if (!candidate) {
    item.status = "failed";
    item.error = item.error ?? "No provider candidate was found.";
    item.completedAt = new Date().toISOString();
    updateJobCounts(job);
    return;
  }

  item.status = "downloading";
  item.startedAt = new Date().toISOString();
  job.updatedAt = item.startedAt;
  updateJobCounts(job);

  try {
    const result = await downloadProviderTrack(
      settings,
      providerTrackFromSpotify(album, item.track),
      candidate,
      item.targetRelativePath
    );

    item.destinationPath = result.destinationPath;
    item.relativePath = result.relativePath;
    item.status = "completed";
    item.completedAt = new Date().toISOString();
    item.error = undefined;
  } catch (error) {
    item.status = "failed";
    item.error = errorMessage(error);
    item.completedAt = new Date().toISOString();
  }

  job.updatedAt = item.completedAt ?? new Date().toISOString();
  updateJobCounts(job);
}

async function searchProviderCandidates(track: CatalogProviderTrack, limit: number) {
  const results = await Promise.all(
    providerIds.map(async (providerId) => {
      try {
        return providerId === "youtube"
          ? await searchYoutubeCandidates(track, limit)
          : await searchJioSaavnCandidates(track, limit);
      } catch {
        return [];
      }
    })
  );
  const candidates = results.flat();

  candidates.sort((left, right) => {
    const providerDelta = providerIds.indexOf(left.providerId) - providerIds.indexOf(right.providerId);
    return providerDelta || right.score.overall - left.score.overall;
  });

  return candidates.slice(0, limit * providerIds.length);
}

async function searchYoutubeCandidates(
  track: CatalogProviderTrack,
  limit: number
): Promise<CatalogProviderCandidate[]> {
  const perQueryLimit = Math.min(
    Math.max(limit, minYoutubeSearchResultsPerQuery),
    maxYoutubeSearchResultsPerQuery
  );
  const candidatesById = new Map<string, CatalogProviderCandidate>();

  for (const searchQuery of youtubeProviderSearchQueries(track)) {
    const searchResult = await runYtDlpSearch(`ytsearch${perQueryLimit}:${searchQuery}`);
    const entries = Array.isArray(searchResult.entries) ? searchResult.entries : [];

    entries
      .map((entry, index) => youtubeCandidateFromEntry(track, entry, index))
      .filter((candidate): candidate is CatalogProviderCandidate => Boolean(candidate))
      .forEach((candidate) => rememberBestCandidate(candidatesById, candidate));

    if (
      candidatesById.size >= limit &&
      bestCandidateScore(candidatesById.values()) >= confidentYoutubeCandidateScore
    ) {
      break;
    }
  }

  return [...candidatesById.values()].sort((left, right) => right.score.overall - left.score.overall);
}

async function searchJioSaavnCandidates(
  track: CatalogProviderTrack,
  limit: number
): Promise<CatalogProviderCandidate[]> {
  const searchUrl = new URL("https://www.jiosaavn.com/api.php");
  searchUrl.search = new URLSearchParams({
    __call: "autocomplete.get",
    _format: "json",
    _marker: "0",
    query: providerSearchQuery(track)
  }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "NaviClean/0.1"
    },
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`JioSaavn search returned HTTP ${response.status}.`);
  }

  const body = (await response.json()) as JioSaavnAutocompleteResponse;
  const entries = Array.isArray(body.songs?.data) ? body.songs.data : [];

  return entries
    .slice(0, limit)
    .map((entry, index) => jioSaavnCandidateFromEntry(track, entry, index))
    .filter((candidate): candidate is CatalogProviderCandidate => Boolean(candidate));
}

async function runYtDlpSearch(searchUrl: string) {
  const timeoutMs = Number(process.env.NAVICLEAN_PROVIDER_SEARCH_TIMEOUT_MS);
  let stdout: Buffer | string;

  try {
    ({ stdout } = await execFileAsync(
      "yt-dlp",
      [
        "--dump-single-json",
        "--flat-playlist",
        "--skip-download",
        "--no-warnings",
        "--quiet",
        ...ytDlpJsRuntimeArgs(),
        "--socket-timeout",
        "8",
        searchUrl
      ],
      {
        maxBuffer: 1024 * 1024 * 4,
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultProviderSearchTimeoutMs
      }
    ));
  } catch (error) {
    throw new Error(formatYtDlpError(error, "YouTube search failed."));
  }

  return JSON.parse(stdout.toString()) as YtDlpSearchResult;
}

function youtubeCandidateFromEntry(
  track: CatalogProviderTrack,
  entry: YtDlpSearchEntry,
  index: number
): CatalogProviderCandidate | null {
  const videoId = extractYoutubeVideoIdFromValue(
    String(entry.id ?? entry.url ?? entry.webpage_url ?? "")
  );

  if (!videoId || !entry.title) {
    return null;
  }

  const title = stripHtmlEntities(String(entry.title));
  const artists = [entry.channel, entry.uploader]
    .filter((value): value is string => Boolean(value))
    .map((value) => stripHtmlEntities(value));
  const durationMs = typeof entry.duration === "number" ? Math.round(entry.duration * 1000) : undefined;
  const score = scoreProviderCandidate(track, {
    artists,
    durationMs,
    title
  });

  const candidate: CatalogProviderCandidate = {
    artists,
    id: `youtube:${videoId}`,
    providerId: "youtube",
    score: {
      ...score,
      overall: Math.max(0, score.overall - index)
    },
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    verified: false
  };

  if (typeof durationMs === "number") {
    candidate.durationMs = durationMs;
  }

  return candidate;
}

function jioSaavnCandidateFromEntry(
  track: CatalogProviderTrack,
  entry: JioSaavnSongEntry,
  index: number
): CatalogProviderCandidate | null {
  const url = entry.perma_url || entry.url;

  if (!url || !entry.title) {
    return null;
  }

  const title = stripHtmlEntities(entry.title);
  const artistText =
    entry.more_info?.primary_artists ||
    entry.more_info?.singers ||
    entry.subtitle ||
    "";
  const artists = splitProviderArtists(stripHtmlEntities(artistText));
  const durationSeconds = Number(entry.more_info?.duration ?? entry.duration);
  const durationMs = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : undefined;
  const album = stripHtmlEntities(entry.more_info?.album ?? "");
  const score = scoreProviderCandidate(track, {
    album,
    artists,
    durationMs,
    title
  });

  const candidate: CatalogProviderCandidate = {
    artists,
    id: `jiosaavn:${entry.id ?? index}`,
    providerId: "jiosaavn",
    score: {
      ...score,
      overall: Math.max(0, score.overall - index)
    },
    title,
    url,
    verified: false
  };

  if (album) {
    candidate.album = album;
  }

  if (typeof durationMs === "number") {
    candidate.durationMs = durationMs;
  }

  return candidate;
}

async function downloadProviderTrack(
  settings: PrivateSettings,
  track: CatalogProviderTrack,
  candidate: CatalogProviderCandidate,
  targetRelativePath: string
): Promise<ProviderDownloadResult> {
  const providerId = assertProvider(candidate.providerId);
  const source = resolveProviderSource(providerId, candidate.url);
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const targetPath = await nextAvailableFilePath(path.resolve(libraryPath, ...targetRelativePath.split("/")));
  const targetDirectory = path.dirname(targetPath);
  const fileBase = path.parse(targetPath).name;
  const stagingDirectory = await createDownloadStagingDirectory(libraryPath);
  const outputTemplate = path.join(stagingDirectory, `${fileBase}.%(ext)s`);
  const beforePaths = await matchingOutputPaths(stagingDirectory, fileBase);

  await fs.mkdir(targetDirectory, { recursive: true });

  try {
    const stdout = await runYtDlp({
      downloadUrl: source.sourceUrl,
      outputTemplate
    });
    const stagedPath = await findDownloadedPath({
      beforePaths,
      outputTemplate,
      stdout,
      targetDirectory: stagingDirectory
    });

    await fs.rename(stagedPath, targetPath);
    await tagDownloadedFile(targetPath, track);

    const fileStats = await fs.stat(targetPath);
    const relativePath = toPosixRelative(libraryPath, targetPath);

    await recordProviderDownload(settings, {
      album: track.album,
      artists: track.artists,
      bytesWritten: fileStats.size,
      confirmedAt: new Date().toISOString(),
      destinationPath: targetPath,
      providerId,
      relativePath,
      sourceUrl: source.sourceUrl,
      trackId: track.id,
      trackName: track.name
    });

    return {
      bytesWritten: fileStats.size,
      destinationPath: targetPath,
      relativePath
    };
  } finally {
    await fs.rm(stagingDirectory, {
      force: true,
      recursive: true
    });
  }
}

async function runYtDlp({
  downloadUrl,
  outputTemplate
}: {
  downloadUrl: string;
  outputTemplate: string;
}) {
  const timeoutMs = Number(process.env.NAVICLEAN_PROVIDER_DOWNLOAD_TIMEOUT_MS);
  let stdout: Buffer | string;

  try {
    ({ stdout } = await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-overwrites",
        "--restrict-filenames",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "320K",
        "--format",
        "bestaudio[abr<=320]/bestaudio/best",
        ...ytDlpJsRuntimeArgs(),
        "--sleep-requests",
        "2",
        "--sleep-interval",
        "5",
        "--max-sleep-interval",
        "10",
        "--print",
        "after_move:filepath",
        "--output",
        outputTemplate,
        downloadUrl
      ],
      {
        maxBuffer: 1024 * 1024 * 2,
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultProviderDownloadTimeoutMs
      }
    ));
  } catch (error) {
    throw new Error(formatYtDlpError(error, "Provider download failed.", downloadUrl));
  }

  return stdout.toString();
}

async function tagDownloadedFile(filePath: string, track: CatalogProviderTrack) {
  const parsedPath = path.parse(filePath);
  const tempPath = path.join(parsedPath.dir, `${parsedPath.name}.naviclean-tagging${parsedPath.ext}`);
  let coverPath: string | null = null;
  const metadataArgs = [
    "-metadata",
    `title=${track.name}`,
    "-metadata",
    `artist=${track.artists.join("; ")}`,
    "-metadata",
    `album=${track.album}`,
    "-metadata",
    `album_artist=${track.albumArtist}`,
    "-metadata",
    `track=${track.trackNumber}`,
    "-metadata",
    `disc=${track.discNumber}`
  ];

  if (track.albumReleaseYear) {
    metadataArgs.push("-metadata", `date=${track.albumReleaseYear}`);
  }

  if (track.spotifyUrl) {
    metadataArgs.push("-metadata", `comment=Spotify metadata: ${track.spotifyUrl}`);
  }

  for (const tag of spotifyBuMetadataTagsForSpotifyTrack({
    albumId: track.albumId,
    albumSpotifyUrl: track.albumSpotifyUrl,
    trackId: track.id,
    trackSpotifyUrl: track.spotifyUrl
  })) {
    metadataArgs.push("-metadata", `${tag.key}=${tag.value}`);
  }

  try {
    coverPath = await downloadSpotifyAlbumCover(parsedPath.dir, parsedPath.name, track.albumImageUrl);
    await writeTaggedAudioFile(filePath, tempPath, metadataArgs, coverPath);
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);

    if (coverPath) {
      try {
        await writeTaggedAudioFile(filePath, tempPath, metadataArgs, null);
        await fs.rename(tempPath, filePath);
      } catch {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
  } finally {
    if (coverPath) {
      await fs.rm(coverPath, { force: true }).catch(() => undefined);
    }
  }
}

async function writeTaggedAudioFile(
  filePath: string,
  tempPath: string,
  metadataArgs: string[],
  coverPath: string | null
) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      filePath,
      ...(coverPath ? ["-i", coverPath] : []),
      "-map",
      "0:a:0",
      ...(coverPath ? ["-map", "1:v:0"] : []),
      "-map_metadata",
      "-1",
      "-c:a",
      "copy",
      ...(coverPath
        ? [
            "-c:v",
            "mjpeg",
            "-disposition:v:0",
            "attached_pic",
            "-metadata:s:v",
            "title=Album cover",
            "-metadata:s:v",
            "comment=Cover (front)"
          ]
        : []),
      "-id3v2_version",
      "3",
      ...metadataArgs,
      tempPath
    ],
    {
      maxBuffer: 1024 * 1024 * 2,
      timeout: 60_000
    }
  );
}

async function downloadSpotifyAlbumCover(
  directory: string,
  fileBase: string,
  imageUrl: string | null
) {
  if (!imageUrl) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (!bytes.length) {
      return null;
    }

    const coverPath = path.join(directory, `${fileBase}.naviclean-cover${coverExtension(contentType)}`);
    await fs.writeFile(coverPath, bytes);

    return coverPath;
  } catch {
    return null;
  }
}

function providerTrackFromSpotify(
  album: SpotifyAlbumDetail,
  track: SpotifyTrackSummary
): CatalogProviderTrack {
  return {
    album: album.name,
    albumId: album.id,
    albumArtist: album.artist.name,
    albumImageUrl: album.imageUrl,
    albumReleaseYear: album.releaseYear,
    albumSpotifyUrl: album.spotifyUrl,
    albumTracksTotal: album.totalTracks,
    albumType: album.albumType,
    artists: track.artists.length ? track.artists : [album.artist.name],
    discNumber: track.discNumber,
    durationMs: track.duration * 1000,
    id: track.id,
    name: track.name,
    spotifyUrl: track.spotifyUrl,
    trackNumber: track.trackNumber
  };
}

function targetRelativePathForTrack(settings: PrivateSettings, track: CatalogProviderTrack) {
  return targetForTrack(providerTrackToTrackFile(settings, track), settings).targetRelativePath;
}

function providerTrackToTrackFile(settings: PrivateSettings, track: CatalogProviderTrack): TrackFile {
  const root = path.resolve(settings.naming.libraryPath);
  const duration = Math.round(track.durationMs / 1000);

  return {
    absolutePath: path.join(root, ".naviclean", "planned", `${track.id}.mp3`),
    album: track.album,
    albumArtist: track.albumArtist,
    albumType: track.albumType,
    bitrate: 320_000,
    bitsPerSample: null,
    codec: "MP3",
    container: "MPEG",
    discNumber: track.discNumber,
    discTotal: null,
    duplicateKey: buildDuplicateKey({
      album: track.album,
      albumType: track.albumType,
      artist: track.albumArtist,
      discNumber: track.discNumber,
      duration,
      title: track.name,
      trackNumber: track.trackNumber,
      year: track.albumReleaseYear
    }),
    duration,
    extension: ".mp3",
    id: sha1(`spotify:${track.id}`),
    issues: [],
    lossless: false,
    mtimeMs: 0,
    qualityScore: 870,
    relativePath: `.naviclean/planned/${track.id}.mp3`,
    sampleRate: null,
    size: 0,
    targetPath: "",
    targetRelativePath: "",
    title: track.name,
    trackNumber: track.trackNumber,
    trackTotal: track.albumTracksTotal,
    year: track.albumReleaseYear,
    artist: track.artists.join(", ") || track.albumArtist
  };
}

function providerSearchQuery(track: CatalogProviderTrack, includeAlbum = false) {
  return uniqueSearchParts([
    track.name,
    track.artists.slice(0, 3).join(" "),
    includeAlbum ? track.album : ""
  ]).join(" ");
}

function youtubeProviderSearchQueries(track: CatalogProviderTrack) {
  return uniqueSearchQueries([
    providerSearchQuery(track, true),
    uniqueSearchParts([track.name, track.artists.slice(0, 2).join(" "), "official audio"]).join(" ")
  ]);
}

function uniqueSearchParts(parts: string[]) {
  const seen = new Set<string>();
  const uniqueParts: string[] = [];

  for (const part of parts) {
    const normalizedPart = part.replace(/\s+/g, " ").trim();
    const key = normalizedPart.toLowerCase();

    if (!normalizedPart || seen.has(key) || key === "unknown album") {
      continue;
    }

    seen.add(key);
    uniqueParts.push(normalizedPart);
  }

  return uniqueParts;
}

function uniqueSearchQueries(queries: string[]) {
  const seen = new Set<string>();
  const uniqueQueries: string[] = [];

  for (const query of queries) {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    const key = normalizedQuery.toLowerCase();

    if (!normalizedQuery || seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueQueries.push(normalizedQuery);
  }

  return uniqueQueries;
}

function scoreProviderCandidate(
  track: CatalogProviderTrack,
  candidate: {
    album?: string;
    artists: string[];
    durationMs?: number;
    title: string;
  }
) {
  const titleScore = titleSimilarity(track.name, candidate.title, track.album);
  const artistScore = artistSimilarity(track.artists, candidate.artists.join(" "), candidate.title);
  const durationDeltaMs =
    typeof candidate.durationMs === "number"
      ? Math.abs(candidate.durationMs - track.durationMs)
      : undefined;
  const durationScore =
    typeof durationDeltaMs === "number"
      ? Math.max(0, 100 - Math.round(durationDeltaMs / 1000) * 3)
      : 50;
  const albumScore = track.album ? albumSimilarity(track.album, candidate.album, candidate.title) : 0;
  const overall = Math.min(
    100,
    Math.round(titleScore * 0.48 + artistScore * 0.34 + durationScore * 0.18 + albumScore * 0.08)
  );

  const score: CatalogProviderCandidateScore = {
    albumScore,
    artistScore,
    overall,
    titleScore
  };

  if (typeof durationDeltaMs === "number") {
    score.durationDeltaMs = durationDeltaMs;
  }

  return score;
}

function titleSimilarity(trackTitle: string, candidateTitle: string, trackAlbum?: string) {
  return Math.max(
    directionalSimilarity(tokenSet(trackTitle), tokenSet(candidateTitle, providerTitleNoiseTokens)),
    ...titleSegments(candidateTitle).map((segment) =>
      directionalSimilarity(tokenSet(trackTitle), tokenSet(segment, providerTitleNoiseTokens))
    ),
    trackAlbum
      ? directionalSimilarity(tokenSet(`${trackTitle} ${trackAlbum}`), tokenSet(candidateTitle, providerTitleNoiseTokens))
      : 0
  );
}

function artistSimilarity(trackArtists: string[], candidateArtistText: string, candidateTitle: string) {
  const artistScores = trackArtists.map((artist) =>
    Math.max(textSimilarity(artist, candidateArtistText), metadataSegmentSimilarity(artist, candidateTitle))
  );

  if (!artistScores.length) {
    return 0;
  }

  const bestScore = Math.max(...artistScores);
  const averageScore = artistScores.reduce((total, score) => total + score, 0) / artistScores.length;

  return Math.round(bestScore * 0.6 + averageScore * 0.4);
}

function albumSimilarity(trackAlbum: string, candidateAlbum: string | undefined, candidateTitle: string) {
  const trackTokens = tokenSet(trackAlbum, albumEditionTokens);
  const candidateValues = [candidateAlbum, ...titleSegments(candidateTitle)].filter(
    (value): value is string => Boolean(value)
  );

  return Math.max(
    ...candidateValues.map((value) => directionalSimilarity(trackTokens, tokenSet(value, albumEditionTokens))),
    0
  );
}

function metadataSegmentSimilarity(target: string, candidateValue: string) {
  const targetTokens = tokenSet(target);

  return Math.max(
    ...titleSegments(candidateValue).map((segment) =>
      directionalSimilarity(targetTokens, tokenSet(segment, providerTitleNoiseTokens))
    ),
    0
  );
}

function textSimilarity(left: string, right: string) {
  return directionalSimilarity(tokenSet(left), tokenSet(right));
}

function directionalSimilarity(targetTokens: Set<string>, candidateTokens: Set<string>) {
  if (!targetTokens.size || !candidateTokens.size) {
    return 0;
  }

  const intersectionCount = countIntersection(targetTokens, candidateTokens);
  const coverage = intersectionCount / targetTokens.size;
  const jaccard = intersectionCount / new Set([...targetTokens, ...candidateTokens]).size;

  return Math.round((coverage * 0.8 + jaccard * 0.2) * 100);
}

function countIntersection(leftTokens: Set<string>, rightTokens: Set<string>) {
  let intersectionCount = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersectionCount += 1;
    }
  }

  return intersectionCount;
}

const providerTitleNoiseTokens = new Set([
  "audio",
  "hd",
  "hq",
  "lyric",
  "lyrics",
  "official",
  "video",
  "visualizer"
]);

const albumEditionTokens = new Set([
  "anniversary",
  "deluxe",
  "edition",
  "expanded",
  "live",
  "remaster",
  "remastered"
]);

function tokenSet(value: string, ignoredTokens = new Set<string>()) {
  return new Set(
    normalizeForMatch(value, { removeBracketedText: false })
      .split(" ")
      .filter((token) => token && !ignoredTokens.has(token))
  );
}

function titleSegments(value: string) {
  return value
    .split(/\s+[-:|]\s+|\(|\)|\[|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function rememberBestCandidate(
  candidatesById: Map<string, CatalogProviderCandidate>,
  candidate: CatalogProviderCandidate
) {
  const existingCandidate = candidatesById.get(candidate.id);

  if (!existingCandidate || candidate.score.overall > existingCandidate.score.overall) {
    candidatesById.set(candidate.id, candidate);
  }
}

function bestCandidateScore(candidates: Iterable<CatalogProviderCandidate>) {
  let bestScore = 0;

  for (const candidate of candidates) {
    bestScore = Math.max(bestScore, candidate.score.overall);
  }

  return bestScore;
}

function splitProviderArtists(value: string) {
  return value
    .split(/,|&|;|\band\b/i)
    .map((artist) => artist.trim())
    .filter(Boolean);
}

function stripHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function createDownloadStagingDirectory(libraryPath: string) {
  const stagingRoot = path.join(libraryPath, ...stagingRootSegments);
  const stagingDirectory = path.join(stagingRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  await fs.mkdir(stagingDirectory, {
    recursive: true
  });

  return stagingDirectory;
}

async function nextAvailableFilePath(filePath: string) {
  const parsedPath = path.parse(filePath);

  for (let count = 0; count < 1000; count += 1) {
    const candidatePath =
      count === 0 ? filePath : path.join(parsedPath.dir, `${parsedPath.name} (${count + 1})${parsedPath.ext}`);

    if (!(await canAccess(candidatePath, constants.F_OK))) {
      return candidatePath;
    }
  }

  throw new Error("Could not find an available destination filename.");
}

async function matchingOutputPaths(directory: string, fileBase: string) {
  const extensions = ["mp3", "m4a", "opus", "webm", "flac"];
  const paths = new Set<string>();

  await Promise.all(
    extensions.map(async (extension) => {
      const filePath = path.join(directory, `${fileBase}.${extension}`);

      if (await canAccess(filePath, constants.F_OK)) {
        paths.add(filePath);
      }
    })
  );

  return paths;
}

async function findDownloadedPath({
  beforePaths,
  outputTemplate,
  stdout,
  targetDirectory
}: {
  beforePaths: Set<string>;
  outputTemplate: string;
  stdout: string;
  targetDirectory: string;
}) {
  const printedPaths = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => path.resolve(line));

  for (const printedPath of printedPaths.reverse()) {
    if (isPathInside(printedPath, targetDirectory)) {
      return printedPath;
    }
  }

  const expectedOutputPath = path.resolve(outputTemplate.replace("%(ext)s", "mp3"));

  if (!beforePaths.has(expectedOutputPath) && (await canAccess(expectedOutputPath, constants.F_OK))) {
    return expectedOutputPath;
  }

  throw new Error("The provider download finished but no output file was found.");
}

async function recordProviderDownload(
  settings: PrivateSettings,
  entry: ProviderDownloadLog["downloads"][number]
) {
  const log = await readProviderDownloadLog(settings);
  const now = new Date().toISOString();

  log.downloads.push(entry);
  log.updatedAt = now;

  const logDirectory = path.join(path.resolve(settings.naming.libraryPath), ".naviclean");
  const logPath = path.join(logDirectory, "provider-downloads.json");

  await fs.mkdir(logDirectory, { recursive: true });
  await fs.writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  return logPath;
}

async function readProviderDownloadLog(settings: PrivateSettings): Promise<ProviderDownloadLog> {
  try {
    const contents = await fs.readFile(
      path.join(path.resolve(settings.naming.libraryPath), ...provenanceLogSegments),
      "utf8"
    );
    const parsed = JSON.parse(contents) as Partial<ProviderDownloadLog>;

    if (parsed.version !== 1 || !Array.isArray(parsed.downloads)) {
      return emptyProviderDownloadLog();
    }

    return parsed as ProviderDownloadLog;
  } catch {
    return emptyProviderDownloadLog();
  }
}

function emptyProviderDownloadLog(): ProviderDownloadLog {
  return {
    downloads: [],
    updatedAt: new Date(0).toISOString(),
    version: 1
  };
}

function updateJobCounts(job: SpotifyCatalogDownloadJob) {
  job.completedCount = job.items.filter((item) => item.status === "completed").length;
  job.failedCount = job.items.filter((item) => item.status === "failed").length;
  job.pendingCount = job.items.filter((item) => item.status === "pending" || item.status === "downloading").length;
}

function snapshotJob(job: SpotifyCatalogDownloadJob): SpotifyCatalogDownloadJob {
  return {
    ...job,
    items: job.items.map((item) => ({ ...item }))
  };
}

function assertProvider(value: string): CatalogProviderId {
  if (value === "youtube" || value === "jiosaavn") {
    return value;
  }

  throw new Error("Choose YouTube or JioSaavn.");
}

function resolveProviderSource(providerId: CatalogProviderId, input: string) {
  const sourceUrl = input.trim();

  if (!sourceUrl) {
    throw new Error("Search and choose a provider candidate before downloading.");
  }

  const url = parseHttpsUrl(sourceUrl);

  if (providerId === "youtube") {
    assertYoutubeUrl(url);
  } else {
    assertJioSaavnSongUrl(url);
  }

  return { sourceUrl };
}

function parseHttpsUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Choose a valid provider result.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Provider downloads require an HTTPS source URL.");
  }

  return url;
}

function assertYoutubeUrl(url: URL) {
  const hostname = normalizedHost(url);
  const isYoutube =
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtu.be";

  if (!isYoutube) {
    throw new Error("Choose a youtube.com or youtu.be result for YouTube.");
  }

  if (hostname !== "youtu.be" && url.pathname !== "/watch") {
    throw new Error("Choose a single YouTube video, not a playlist page.");
  }

  if (hostname !== "youtu.be" && !url.searchParams.get("v")) {
    throw new Error("Choose a single YouTube video result.");
  }
}

function assertJioSaavnSongUrl(url: URL) {
  const hostname = normalizedHost(url);

  if (
    hostname !== "jiosaavn.com" &&
    hostname !== "www.jiosaavn.com" &&
    hostname !== "saavn.com" &&
    hostname !== "www.saavn.com"
  ) {
    throw new Error("Choose a JioSaavn song result.");
  }

  if (!url.pathname.includes("/song/")) {
    throw new Error("Choose a single JioSaavn song, not an album or playlist.");
  }
}

function normalizedHost(url: URL) {
  return url.hostname.toLowerCase();
}

function sanitizeYoutubeVideoId(value: string) {
  const match = value.match(/^[A-Za-z0-9_-]{6,20}$/);

  return match?.[0] ?? null;
}

function extractYoutubeVideoIdFromValue(value: string) {
  const directId = sanitizeYoutubeVideoId(value);

  if (directId) {
    return directId;
  }

  try {
    const url = new URL(value);
    const hostname = normalizedHost(url);

    if (hostname === "youtu.be") {
      return sanitizeYoutubeVideoId(url.pathname.replace(/^\//, ""));
    }

    if (hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "m.youtube.com") {
      return sanitizeYoutubeVideoId(url.searchParams.get("v") ?? "");
    }
  } catch {
    return null;
  }

  return null;
}

function ytDlpJsRuntimeArgs() {
  const configuredRuntime = process.env.NAVICLEAN_YTDLP_JS_RUNTIME?.trim();
  const runtime =
    configuredRuntime === "none" ? "" : configuredRuntime || defaultYtDlpJsRuntime;

  return runtime ? ["--js-runtimes", runtime] : [];
}

function formatYtDlpError(error: unknown, fallbackMessage: string, sourceUrl?: string) {
  const execError = error as ExecFileError;
  const output = [
    bufferishToString(execError.stderr),
    bufferishToString(execError.stdout),
    error instanceof Error ? error.message : ""
  ]
    .filter(Boolean)
    .join("\n");
  const normalizedOutput = output.toLowerCase();
  const sourceHost = sourceUrl ? safeHostname(sourceUrl) : "";
  const diagnosticLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isYtDlpDiagnosticLine);
  const lastErrorLine = [...diagnosticLines]
    .reverse()
    .find((line) => /^error:/i.test(line) || /^warning:/i.test(line));
  const lastDiagnosticLine = lastErrorLine ?? diagnosticLines.at(-1);
  const exitCode =
    execError.code && execError.code !== "ETIMEDOUT" ? `yt-dlp exit code: ${execError.code}.` : "";
  const youtubeExtractorFailed =
    sourceHost.includes("youtube") ||
    sourceHost.includes("youtu.be") ||
    normalizedOutput.includes("[youtube]");

  if (
    youtubeExtractorFailed &&
    (normalizedOutput.includes("precondition check failed") ||
      normalizedOutput.includes("signature extraction failed") ||
      normalizedOutput.includes("n challenge") ||
      normalizedOutput.includes("only images are available") ||
      normalizedOutput.includes("requested format is not available"))
  ) {
    return [
      "YouTube did not expose a downloadable audio stream for that result.",
      "Pull or rebuild the latest NaviClean image so yt-dlp and the Node challenge runtime are current.",
      "If this specific video still fails, choose a JioSaavn candidate or another YouTube result.",
      lastDiagnosticLine ? `yt-dlp reported: ${formatYtDlpDiagnosticLine(lastDiagnosticLine)}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (execError.code === "ETIMEDOUT") {
    return fallbackMessage.toLowerCase().includes("search")
      ? "The provider search timed out. Try again, or use another provider result if one is available."
      : "The provider download timed out. Try again or choose another source.";
  }

  return [
    fallbackMessage,
    exitCode,
    lastDiagnosticLine ? `yt-dlp output: ${formatYtDlpDiagnosticLine(lastDiagnosticLine)}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function isYtDlpDiagnosticLine(line: string) {
  return (
    Boolean(line) &&
    !/^\[download\]\s+\d+(?:\.\d+)?%/i.test(line) &&
    !/^\[download\]\s+(destination|has already been downloaded)/i.test(line)
  );
}

function formatYtDlpDiagnosticLine(line: string) {
  const stripped = stripYtDlpPrefix(line).replace(/\s+/g, " ").trim();

  return stripped.length > 360 ? `${stripped.slice(0, 357)}...` : stripped;
}

function bufferishToString(value: Buffer | string | undefined) {
  return typeof value === "string" ? value : value?.toString() ?? "";
}

function safeHostname(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function stripYtDlpPrefix(value: string) {
  return value.replace(/^(error|warning):\s*/i, "");
}

function coverExtension(contentType: string) {
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("png")) {
    return ".png";
  }

  if (normalizedContentType.includes("webp")) {
    return ".webp";
  }

  return ".jpg";
}

async function canAccess(filePath: string, mode: number) {
  try {
    await fs.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(child: string, parent: string) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Provider action failed.";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(Math.max(concurrency, 1), items.length || 1)
      },
      () => worker()
    )
  );

  return results;
}

function providerJobId() {
  return `navidl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
