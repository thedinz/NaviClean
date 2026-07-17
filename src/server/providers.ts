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
import { loadCatalog, saveCatalog } from "./catalog.js";
import { buildDuplicateKey } from "./matching.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { trackKeepMetadataTagsForSpotifyTrack } from "./trackkeep.js";
import { normalizeForMatch, sha1, toPosixRelative } from "./utils.js";
import { buildSpotifyDownloadPlan } from "./spotify.js";

export type CatalogProviderTrack = {
  album: string;
  albumId: string;
  albumArtist: string;
  albumImageUrl: string | null;
  albumReleaseDate: string;
  albumReleaseYear: number | null;
  albumTracksTotal: number;
  albumType: string;
  artists: string[];
  discNumber: number;
  durationMs: number;
  id: string;
  isrc: string | null;
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
  format: ProviderDownloadFormat;
  mtimeMs: number;
  quality: ProviderDownloadQuality;
  relativePath: string;
};

export type ProviderDownloadFormat = "opus" | "mp3";
export type ProviderDownloadQuality = 160 | 192 | 256 | 320;

type ProviderDownloadProfile = {
  bitrate: number;
  codec: string;
  container: string;
  extension: ".opus" | ".mp3";
  format: ProviderDownloadFormat;
  quality: ProviderDownloadQuality;
  qualityScore: number;
};

type ProviderDownloadLog = {
  downloads: Array<{
    album: string;
    artists: string[];
    bytesWritten: number;
    confirmedAt: string;
    destinationPath: string;
    format: ProviderDownloadFormat;
    providerId: CatalogProviderId;
    quality: ProviderDownloadQuality;
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
const maxPreviewConcurrency = 3;
const minYoutubeSearchResultsPerQuery = 5;
const maxYoutubeSearchResultsPerQuery = 20;
const defaultProviderSearchTimeoutMs = 20_000;
const defaultProviderDownloadTimeoutMs = 600_000;
const confidentYoutubeCandidateScore = 94;
const stagingRootSegments = [".naviclean", "tmp", "provider-downloads"];
const provenanceLogSegments = [".naviclean", "provider-downloads.json"];
const defaultYtDlpJsRuntime = "node";
export function providerDownloadProfile(
  settings: PrivateSettings,
  format: ProviderDownloadFormat = "opus"
): ProviderDownloadProfile {
  const quality = format === "opus"
    ? settings.catalog.providers.opusQuality
    : settings.catalog.providers.mp3FallbackQuality;
  return {
    bitrate: quality * 1000,
    codec: format === "opus" ? "Opus" : "MP3",
    container: format === "opus" ? "Ogg Opus" : "MPEG",
    extension: format === "opus" ? ".opus" : ".mp3",
    format,
    quality,
    qualityScore: format === "opus" ? 900 + quality / 10 : 700 + quality / 10
  };
}
const jobs = new Map<string, SpotifyCatalogDownloadJob>();
let catalogUpdateQueue: Promise<void> = Promise.resolve();

export async function previewSpotifyCatalogDownloads(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string,
  trackIds?: string[]
): Promise<SpotifyCatalogDownloadPreviewResult> {
  const plan = await buildSpotifyDownloadPlan(settings, localTracks, albumId, trackIds);
  const selectedTracks = plan.selectedTracks;
  const items = await mapWithConcurrency(
    selectedTracks,
    maxPreviewConcurrency,
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
  reviewedCandidates,
  settings,
  trackIds
}: {
  albumId: string;
  bulkRiskAccepted: boolean;
  localTracks: TrackFile[];
  rightsConfirmed: boolean;
  reviewedCandidates?: Array<{ candidate: CatalogProviderCandidate; trackId: string }>;
  settings: PrivateSettings;
  trackIds?: string[];
}) {
  if (!rightsConfirmed) {
    throw new Error("Confirm you are authorized to download the selected tracks first.");
  }

  if (!bulkRiskAccepted) {
    throw new Error("Accept the provider and bulk-download risk warning first.");
  }

  const preview = reviewedCandidates?.length
    ? await previewReviewedProviderCandidates(
        settings,
        localTracks,
        albumId,
        trackIds,
        reviewedCandidates
      )
    : await previewSpotifyCatalogDownloads(settings, localTracks, albumId, trackIds);
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

    await registerProviderDownloadInCatalog(
      providerDownloadResultToTrackFile(settings, providerTrackFromSpotify(album, item.track), result)
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
  return withProviderFormatFallback(settings, (format) =>
    downloadProviderTrackAsFormat(settings, track, candidate, targetRelativePath, format)
  );
}

async function previewReviewedProviderCandidates(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string,
  trackIds: string[] | undefined,
  reviewedCandidates: Array<{ candidate: CatalogProviderCandidate; trackId: string }>
): Promise<SpotifyCatalogDownloadPreviewResult> {
  const plan = await buildSpotifyDownloadPlan(settings, localTracks, albumId, trackIds);
  const candidatesByTrackId = new Map(
    reviewedCandidates.map((item) => [item.trackId, item.candidate] as const)
  );
  const items = plan.selectedTracks.map((track) => {
    const candidate = candidatesByTrackId.get(track.id) ?? null;
    const providerTrack = providerTrackFromSpotify(plan.album, track);
    return {
      candidates: candidate ? [candidate] : [],
      error: candidate ? undefined : "No reviewed provider candidate was found.",
      selectedCandidate: candidate,
      targetRelativePath: targetRelativePathForTrack(settings, providerTrack),
      track
    } satisfies SpotifyCatalogDownloadPreviewItem;
  });
  const downloadableCount = items.filter((item) => item.selectedCandidate).length;

  return {
    album: plan.album,
    downloadableCount,
    failedCount: items.length - downloadableCount,
    generatedAt: new Date().toISOString(),
    items,
    warnings: plan.warnings
  };
}

export async function withProviderFormatFallback<T>(
  settings: PrivateSettings,
  attempt: (format: ProviderDownloadFormat) => Promise<T>
) {
  try {
    return await attempt("opus");
  } catch (opusError) {
    if (!settings.catalog.providers.mp3FallbackEnabled || !isProviderFormatFailure(opusError)) {
      throw opusError;
    }
    try {
      return await attempt("mp3");
    } catch (mp3Error) {
      throw new Error(`Provider download failed as Opus and MP3 fallback. Opus: ${errorMessage(opusError)} MP3: ${errorMessage(mp3Error)}`);
    }
  }
}

async function downloadProviderTrackAsFormat(
  settings: PrivateSettings,
  track: CatalogProviderTrack,
  candidate: CatalogProviderCandidate,
  targetRelativePath: string,
  format: ProviderDownloadFormat
): Promise<ProviderDownloadResult> {
  const providerId = assertProvider(candidate.providerId);
  const source = resolveProviderSource(providerId, candidate.url);
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const profile = providerDownloadProfile(settings, format);
  const requestedRelativePath = replacePathExtension(targetRelativePath, profile.extension);
  const targetPath = await nextAvailableFilePath(path.resolve(libraryPath, ...requestedRelativePath.split("/")));
  const targetDirectory = path.dirname(targetPath);
  const fileBase = path.parse(targetPath).name;
  const stagingDirectory = await createDownloadStagingDirectory(libraryPath);
  const outputTemplate = path.join(stagingDirectory, `${fileBase}.%(ext)s`);
  const beforePaths = await matchingOutputPaths(stagingDirectory, fileBase);

  await fs.mkdir(targetDirectory, { recursive: true });

  try {
    const stdout = await runYtDlp({
      downloadUrl: source.sourceUrl,
      format,
      outputTemplate,
      quality: profile.quality
    });
    let stagedPath = await findDownloadedPath({
      beforePaths,
      format,
      outputTemplate,
      stdout,
      targetDirectory: stagingDirectory
    });

    stagedPath = await normalizeStagedAudioFile({ format, quality: profile.quality, stagedPath });

    await tagDownloadedFile(stagedPath, track);
    await fs.rename(stagedPath, targetPath);

    const fileStats = await fs.stat(targetPath);
    const relativePath = toPosixRelative(libraryPath, targetPath);

    await recordProviderDownload(settings, {
      album: track.album,
      artists: track.artists,
      bytesWritten: fileStats.size,
      confirmedAt: new Date().toISOString(),
      destinationPath: targetPath,
      format,
      providerId,
      quality: profile.quality,
      relativePath,
      sourceUrl: source.sourceUrl,
      trackId: track.id,
      trackName: track.name
    });

    return {
      bytesWritten: fileStats.size,
      destinationPath: targetPath,
      format,
      mtimeMs: fileStats.mtimeMs,
      quality: profile.quality,
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
  format,
  outputTemplate,
  quality
}: {
  downloadUrl: string;
  format: ProviderDownloadFormat;
  outputTemplate: string;
  quality: ProviderDownloadQuality;
}) {
  const timeoutMs = Number(process.env.NAVICLEAN_PROVIDER_DOWNLOAD_TIMEOUT_MS);
  let stdout: Buffer | string;

  try {
    ({ stdout } = await execFileAsync(
      "yt-dlp",
      providerYtDlpArgs({ downloadUrl, format, outputTemplate, quality }),
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

export function providerYtDlpArgs({
  downloadUrl,
  format,
  outputTemplate,
  quality
}: {
  downloadUrl: string;
  format: ProviderDownloadFormat;
  outputTemplate: string;
  quality: ProviderDownloadQuality;
}) {
  return [
    "--no-playlist", "--no-overwrites", "--restrict-filenames", "--extract-audio",
    "--audio-format", format, "--audio-quality", `${quality}K`,
    "--format", `bestaudio[abr<=${quality}]/bestaudio/best`,
    ...ytDlpJsRuntimeArgs(),
    "--sleep-requests", "2", "--sleep-interval", "5", "--max-sleep-interval", "10",
    "--print", "after_move:filepath", "--output", outputTemplate, downloadUrl
  ];
}

export async function normalizeStagedAudioFile({
  format,
  quality,
  stagedPath
}: {
  format: ProviderDownloadFormat;
  quality: ProviderDownloadQuality;
  stagedPath: string;
}) {
  if (!(await shouldNormalizeStagedAudioFile({ format, quality, stagedPath }))) {
    return stagedPath;
  }

  const parsed = path.parse(stagedPath);
  const targetPath = path.join(parsed.dir, `${parsed.name}.naviclean-normalized.${format}`);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-i", stagedPath, "-map", "0:a:0", "-vn", "-map_metadata", "-1",
        "-codec:a", format === "opus" ? "libopus" : "libmp3lame",
        "-b:a", `${quality}k`,
        ...(format === "mp3" ? ["-id3v2_version", "3"] : []),
        targetPath
      ],
      { maxBuffer: 1024 * 1024 * 2, timeout: 60_000 }
    );
  } catch (error) {
    throw new Error(`Provider audio normalization failed: ${formatFfmpegError(error)}`);
  }

  await fs.rm(stagedPath, { force: true }).catch(() => undefined);
  return targetPath;
}

export async function shouldNormalizeStagedAudioFile({
  format,
  quality,
  stagedPath
}: {
  format: ProviderDownloadFormat;
  quality: ProviderDownloadQuality;
  stagedPath: string;
}) {
  if (path.extname(stagedPath).toLowerCase() !== `.${format}`) {
    return true;
  }

  const encoding = await probeStagedAudioEncoding(stagedPath).catch(() => null);
  if (!encoding || encoding.codecName !== format) {
    return true;
  }
  return encoding.bitRate ? encoding.bitRate > quality * 1000 * 1.25 : false;
}

async function probeStagedAudioEncoding(filePath: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 1024 * 1024, timeout: 30_000 }
  );
  const probe = JSON.parse(stdout.toString()) as {
    format?: { bit_rate?: string };
    streams?: Array<{ bit_rate?: string; codec_name?: string; codec_type?: string }>;
  };
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const bitrate = Number(audio?.bit_rate ?? probe.format?.bit_rate);
  return {
    bitRate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    codecName: audio?.codec_name?.toLowerCase() ?? ""
  };
}

function isProviderFormatFailure(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return [
    "audio conversion failed", "could not write header", "encoder", "ffmpeg",
    "invalid audio format", "libopus", "postprocessing", "requested audio format",
    "unsupported codec", "provider audio normalization failed"
  ].some((needle) => message.includes(needle));
}

function replacePathExtension(filePath: string, extension: string) {
  const parsed = path.posix.parse(filePath.replace(/\\/g, "/"));
  return path.posix.join(parsed.dir, `${parsed.name}${extension}`);
}

async function tagDownloadedFile(filePath: string, track: CatalogProviderTrack) {
  const parsedPath = path.parse(filePath);
  const tempPath = path.join(parsedPath.dir, `${parsedPath.name}.naviclean-tagging${parsedPath.ext}`);
  let coverPath: string | null = null;
  const metadataArgs = providerMetadataArgsForSpotifyTrack(track);

  try {
    coverPath = await downloadSpotifyAlbumCover(parsedPath.dir, parsedPath.name, track.albumImageUrl);
    await writeTaggedAudioFile(filePath, tempPath, metadataArgs, coverPath);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not tag provider audio: ${formatFfmpegError(error)}`);
  } finally {
    if (coverPath) {
      await fs.rm(coverPath, { force: true }).catch(() => undefined);
    }
  }
}

export function providerMetadataArgsForSpotifyTrack(track: CatalogProviderTrack) {
  const releaseDate = track.albumReleaseDate || (track.albumReleaseYear ? String(track.albumReleaseYear) : "");
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

  if (track.isrc) {
    metadataArgs.push("-metadata", `isrc=${track.isrc}`);
  }

  if (releaseDate) {
    metadataArgs.push("-metadata", `date=${releaseDate}`);
    metadataArgs.push("-metadata", `releasedate=${releaseDate}`);
  }

  if (track.albumType.trim().toLowerCase() === "compilation") {
    metadataArgs.push("-metadata", "compilation=1");
  }

  if (track.spotifyUrl) {
    metadataArgs.push("-metadata", `comment=Spotify metadata: ${track.spotifyUrl}`);
  }

  for (const tag of trackKeepMetadataTagsForSpotifyTrack({
    albumId: track.albumId,
    isrc: track.isrc,
    trackId: track.id
  })) {
    metadataArgs.push("-metadata", `${tag.key}=${tag.value}`);
  }

  return metadataArgs;
}

export async function writeTaggedAudioFile(
  filePath: string,
  tempPath: string,
  metadataArgs: string[],
  coverPath: string | null
) {
  const isOpus = path.extname(tempPath).toLowerCase() === ".opus";
  const pictureMetadataPath = coverPath && isOpus
    ? await writeOggOpusPictureMetadataFile(tempPath, coverPath)
    : null;

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        filePath,
        ...(pictureMetadataPath ? ["-f", "ffmetadata", "-i", pictureMetadataPath] : []),
        ...(coverPath && !isOpus ? ["-i", coverPath] : []),
      "-map",
      "0:a:0",
      ...(coverPath && !isOpus ? ["-map", "1:v:0"] : []),
      "-map_metadata",
      pictureMetadataPath ? "1" : "-1",
      "-map_metadata:s:a:0",
      "-1",
      "-c:a",
      "copy",
      ...(coverPath && !isOpus
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
      ...(path.extname(tempPath).toLowerCase() === ".mp3" ? ["-id3v2_version", "3"] : []),
      ...metadataArgs,
      tempPath
      ],
      {
        maxBuffer: 1024 * 1024 * 2,
        timeout: 60_000
      }
    );
  } finally {
    if (pictureMetadataPath) {
      await fs.rm(pictureMetadataPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function writeOggOpusPictureMetadataFile(audioTempPath: string, coverPath: string) {
  const parsedPath = path.parse(audioTempPath);
  const metadataPath = path.join(parsedPath.dir, `${parsedPath.name}.naviclean-picture.ffmetadata`);
  const pictureBlock = await flacPictureBlockBase64(coverPath);
  await fs.writeFile(
    metadataPath,
    [";FFMETADATA1", `METADATA_BLOCK_PICTURE=${escapeFfmetadataValue(pictureBlock)}`, ""].join("\n"),
    "utf8"
  );
  return metadataPath;
}

function escapeFfmetadataValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\\n").replaceAll("=", "\\=").replaceAll(";", "\\;").replaceAll("#", "\\#");
}

async function flacPictureBlockBase64(coverPath: string) {
  const imageBytes = await fs.readFile(coverPath);
  const mimeBytes = Buffer.from(coverMimeType(coverPath), "utf8");
  const descriptionBytes = Buffer.from("Cover (front)", "utf8");
  return Buffer.concat([
    uint32Be(3), uint32Be(mimeBytes.length), mimeBytes,
    uint32Be(descriptionBytes.length), descriptionBytes,
    uint32Be(0), uint32Be(0), uint32Be(0), uint32Be(0),
    uint32Be(imageBytes.length), imageBytes
  ]).toString("base64");
}

function coverMimeType(coverPath: string) {
  const extension = path.extname(coverPath).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
}

function uint32Be(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
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
    albumReleaseDate: album.releaseDate,
    albumReleaseYear: album.releaseYear,
    albumTracksTotal: album.totalTracks,
    albumType: album.albumType,
    artists: track.artists.length ? track.artists : [album.artist.name],
    discNumber: track.discNumber,
    durationMs: track.duration * 1000,
    id: track.id,
    isrc: track.isrc,
    name: track.name,
    spotifyUrl: track.spotifyUrl,
    trackNumber: track.trackNumber
  };
}

function targetRelativePathForTrack(settings: PrivateSettings, track: CatalogProviderTrack) {
  return targetForTrack(providerTrackToTrackFile(settings, track), settings).targetRelativePath;
}

export function providerTrackToTrackFile(settings: PrivateSettings, track: CatalogProviderTrack): TrackFile {
  const root = path.resolve(settings.naming.libraryPath);
  const duration = Math.round(track.durationMs / 1000);
  const profile = providerDownloadProfile(settings);

  return {
    absolutePath: path.join(root, ".naviclean", "planned", `${track.id}${profile.extension}`),
    album: track.album,
    albumArtist: track.albumArtist,
    albumType: track.albumType,
    bitrate: profile.bitrate,
    bitsPerSample: null,
    codec: profile.codec,
    container: profile.container,
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
    extension: profile.extension,
    id: sha1(`spotify:${track.id}`),
    isrc: track.isrc,
    issues: [],
    lossless: false,
    mtimeMs: 0,
    qualityScore: profile.qualityScore,
    relativePath: `.naviclean/planned/${track.id}${profile.extension}`,
    sampleRate: null,
    size: 0,
    targetPath: "",
    targetRelativePath: "",
    title: track.name,
    trackNumber: track.trackNumber,
    trackTotal: track.albumTracksTotal,
    year: track.albumReleaseYear,
    artist: track.artists.join(", ") || track.albumArtist,
    targetSource: "spotify"
  };
}

function providerDownloadResultToTrackFile(
  settings: PrivateSettings,
  track: CatalogProviderTrack,
  result: ProviderDownloadResult
): TrackFile {
  const planned = providerTrackToTrackFile(settings, track);
  const profile = providerDownloadProfile(settings, result.format);

  return {
    ...planned,
    absolutePath: result.destinationPath,
    bitrate: profile.bitrate,
    codec: profile.codec,
    container: profile.container,
    extension: profile.extension,
    managedBy: "trackkeep",
    mtimeMs: result.mtimeMs,
    qualityScore: profile.qualityScore,
    relativePath: result.relativePath,
    size: result.bytesWritten,
    targetPath: result.destinationPath,
    targetRelativePath: result.relativePath
  };
}

async function registerProviderDownloadInCatalog(track: TrackFile) {
  const update = catalogUpdateQueue.then(async () => {
    const catalog = await loadCatalog();
    const tracks = catalog.tracks.filter(
      (candidate) => candidate.id !== track.id && candidate.absolutePath !== track.absolutePath
    );
    tracks.push(track);
    await saveCatalog(tracks);
  });

  catalogUpdateQueue = update.catch(() => undefined);
  await update;
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
  format,
  outputTemplate,
  stdout,
  targetDirectory
}: {
  beforePaths: Set<string>;
  format: ProviderDownloadFormat;
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

  const expectedOutputPath = path.resolve(outputTemplate.replace("%(ext)s", format));

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

function formatFfmpegError(error: unknown) {
  const execError = error as ExecFileError;
  const output = [
    bufferishToString(execError.stderr),
    bufferishToString(execError.stdout),
    error instanceof Error ? error.message : ""
  ].filter(Boolean).join("\n");
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => /error|failed|invalid|unable/i.test(line))
    ?? (error instanceof Error ? error.message : "ffmpeg failed");
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
