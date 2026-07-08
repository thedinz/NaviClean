import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AudioConvertExtensionGroup,
  AudioConvertFile,
  AudioConvertJob,
  AudioConvertJobItem,
  AudioConvertQuality,
  AudioConvertTargetFormat,
  AudioConvertView,
  TrackFile
} from "../shared/types.js";
import { loadCatalog } from "./catalog.js";
import { scanLibrary } from "./scanner.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, toPosixRelative } from "./utils.js";

type StoredAudioConvertJobItem = AudioConvertJobItem & {
  duration: number | null;
  sourceMtimeMs: number;
  sourcePath: string;
  targetPath: string;
};

type StoredAudioConvertJob = Omit<AudioConvertJob, "items"> & {
  items: StoredAudioConvertJobItem[];
};

type ConversionCodecOptions = {
  targetFormat: AudioConvertTargetFormat;
  quality: AudioConvertQuality;
};

type ExecFileError = Error & {
  code?: number | string;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

const jobs = new Map<string, StoredAudioConvertJob>();
const targetFormats: AudioConvertTargetFormat[] = ["mp3", "flac", "m4a", "opus", "ogg", "wav"];
const lossyQualities = new Set<AudioConvertQuality>(["128k", "192k", "256k", "320k"]);
const targetExtensions: Record<AudioConvertTargetFormat, string> = {
  flac: ".flac",
  m4a: ".m4a",
  mp3: ".mp3",
  ogg: ".ogg",
  opus: ".opus",
  wav: ".wav"
};

export function buildAudioConvertView(settings: PrivateSettings, tracks: TrackFile[]): AudioConvertView {
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const groups = new Map<string, AudioConvertExtensionGroup>();

  for (const track of tracks) {
    const extension = normalizeExtension(track.extension);

    if (!extension) {
      continue;
    }

    const group = groups.get(extension) ?? {
      count: 0,
      extension,
      files: [],
      totalSize: 0
    };
    const file = audioConvertFile(track);

    group.count += 1;
    group.totalSize += track.size;
    group.files.push(file);
    groups.set(extension, group);
  }

  const sortedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      files: group.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    }))
    .sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension));

  return {
    groups: sortedGroups,
    libraryPath,
    totalFiles: tracks.length,
    totalSize: tracks.reduce((total, track) => total + track.size, 0)
  };
}

export async function listAudioConvertView(settings: PrivateSettings) {
  const catalog = await loadCatalog();
  return buildAudioConvertView(settings, catalog.tracks);
}

export async function startAudioConvertJob({
  quality,
  settings,
  sourceExtension,
  targetFormat,
  trackIds
}: {
  quality: AudioConvertQuality;
  settings: PrivateSettings;
  sourceExtension: string;
  targetFormat: AudioConvertTargetFormat;
  trackIds?: string[];
}) {
  if (getActiveAudioConvertJob()) {
    throw new Error("A conversion job is already running. Wait for it to finish before starting another one.");
  }

  const normalizedSourceExtension = normalizeExtension(sourceExtension);
  const normalizedTargetFormat = assertTargetFormat(targetFormat);
  const normalizedQuality = assertQualityForTarget(normalizedTargetFormat, quality);
  const targetExtension = targetExtensions[normalizedTargetFormat];

  if (!normalizedSourceExtension) {
    throw new Error("Choose a source extension to convert.");
  }

  if (normalizedSourceExtension === targetExtension) {
    throw new Error("Choose a target format that is different from the source extension.");
  }

  const catalog = await loadCatalog();
  const selectedTracks = selectAudioConvertTracks(catalog.tracks, normalizedSourceExtension, trackIds);

  if (selectedTracks.length === 0) {
    throw new Error(
      trackIds
        ? "Choose at least one matching file to convert."
        : `No ${normalizedSourceExtension.toUpperCase()} files are in the current catalog. Run a scan and try again.`
    );
  }

  const libraryPath = path.resolve(settings.naming.libraryPath);
  const now = new Date().toISOString();
  const job: StoredAudioConvertJob = {
    completedCount: 0,
    createdAt: now,
    errors: [],
    failedCount: 0,
    id: audioConvertJobId(),
    items: selectedTracks.map((track) => audioConvertJobItem(track, libraryPath, targetExtension)),
    pendingCount: selectedTracks.length,
    quality: normalizedQuality,
    sourceExtension: normalizedSourceExtension,
    status: "queued",
    targetFormat: normalizedTargetFormat,
    totalCount: selectedTracks.length,
    updatedAt: now
  };

  updateJobCounts(job);
  jobs.set(job.id, job);
  setTimeout(() => {
    void runAudioConvertJob(settings, job.id);
  }, 0);

  return snapshotJob(job);
}

export function selectAudioConvertTracks(
  tracks: TrackFile[],
  sourceExtension: string,
  trackIds?: string[]
) {
  const normalizedSourceExtension = normalizeExtension(sourceExtension);
  const sourceTracks = tracks.filter((track) => normalizeExtension(track.extension) === normalizedSourceExtension);

  if (!trackIds) {
    return sourceTracks;
  }

  const selectedTrackIds = new Set(trackIds.map((trackId) => trackId.trim()).filter(Boolean));

  if (selectedTrackIds.size === 0) {
    return [];
  }

  const selectedTracks = sourceTracks.filter((track) => selectedTrackIds.has(track.id));

  if (selectedTracks.length !== selectedTrackIds.size) {
    throw new Error("Some selected files are no longer available for this source format. Refresh and try again.");
  }

  return selectedTracks;
}

export function getAudioConvertJob(jobId: string) {
  const job = jobs.get(jobId);
  return job ? snapshotJob(job) : null;
}

export function getActiveAudioConvertJob() {
  const job = [...jobs.values()].find((candidate) => candidate.status === "queued" || candidate.status === "running");
  return job ? snapshotJob(job) : null;
}

export function targetExtensionForAudioConvertFormat(format: AudioConvertTargetFormat) {
  return targetExtensions[assertTargetFormat(format)];
}

function audioConvertFile(track: TrackFile): AudioConvertFile {
  return {
    album: track.album,
    artist: track.artist,
    bitrate: track.bitrate,
    duration: track.duration,
    extension: normalizeExtension(track.extension),
    id: track.id,
    lossless: track.lossless,
    relativePath: track.relativePath,
    size: track.size,
    title: track.title
  };
}

function audioConvertJobItem(track: TrackFile, libraryPath: string, targetExtension: string): StoredAudioConvertJobItem {
  const sourcePath = path.resolve(track.absolutePath);
  const targetPath = convertedTargetPath(sourcePath, targetExtension);

  return {
    duration: track.duration,
    outputSize: null,
    progress: 0,
    sourceMtimeMs: track.mtimeMs,
    sourcePath,
    sourceRelativePath: track.relativePath,
    sourceSize: track.size,
    status: "pending",
    targetPath,
    targetRelativePath: toPosixRelative(libraryPath, targetPath),
    trackId: track.id
  };
}

function convertedTargetPath(sourcePath: string, targetExtension: string) {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}${targetExtension}`);
}

async function runAudioConvertJob(settings: PrivateSettings, jobId: string) {
  const job = jobs.get(jobId);

  if (!job || job.status === "running") {
    return;
  }

  job.status = "running";
  job.updatedAt = new Date().toISOString();
  updateJobCounts(job);

  for (const item of job.items) {
    if (item.status === "pending") {
      await runAudioConvertJobItem(settings, job, item);
    }
  }

  updateJobCounts(job);

  try {
    await scanLibrary(settings);
  } catch (error) {
    job.errors.push(`Catalog refresh failed after conversion: ${errorMessage(error)}`);
  }

  updateJobCounts(job);
  job.status = job.failedCount === job.totalCount ? "failed" : "completed";
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
}

async function runAudioConvertJobItem(
  settings: PrivateSettings,
  job: StoredAudioConvertJob,
  item: StoredAudioConvertJobItem
) {
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const tempPath = temporaryTargetPath(item.targetPath, job.id);

  item.status = "converting";
  item.progress = 0;
  item.startedAt = new Date().toISOString();
  item.error = undefined;
  job.updatedAt = item.startedAt;
  updateJobCounts(job);

  try {
    await assertConvertiblePaths(libraryPath, item.sourcePath, item.targetPath);
    await fs.rm(tempPath, { force: true });
    await runFfmpegConversion(item.sourcePath, tempPath, {
      duration: item.duration,
      quality: job.quality,
      targetFormat: job.targetFormat,
      onProgress: (progress) => {
        item.progress = progress;
        job.updatedAt = new Date().toISOString();
      }
    });

    const outputStats = await fs.stat(tempPath);

    if (outputStats.size <= 0) {
      throw new Error("ffmpeg produced an empty output file.");
    }

    if (await canAccess(item.targetPath, constants.F_OK)) {
      throw new Error(`Target already exists: ${item.targetRelativePath}`);
    }

    await fs.rename(tempPath, item.targetPath);
    await fs.utimes(item.targetPath, new Date(), new Date(item.sourceMtimeMs)).catch(() => undefined);

    try {
      await fs.rm(item.sourcePath);
    } catch (error) {
      await fs.rm(item.targetPath, { force: true }).catch(() => undefined);
      throw new Error(`Converted output was created, but the original could not be deleted: ${errorMessage(error)}`);
    }

    item.completedAt = new Date().toISOString();
    item.outputSize = outputStats.size;
    item.progress = 100;
    item.status = "completed";
  } catch (error) {
    item.completedAt = new Date().toISOString();
    item.error = errorMessage(error);
    item.progress = 0;
    item.status = "failed";
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  job.updatedAt = item.completedAt ?? new Date().toISOString();
  updateJobCounts(job);
}

async function assertConvertiblePaths(libraryPath: string, sourcePath: string, targetPath: string) {
  if (!isInsidePath(libraryPath, sourcePath) || !isInsidePath(libraryPath, targetPath)) {
    throw new Error("Conversion paths must stay inside the configured music library.");
  }

  if (!(await canAccess(sourcePath, constants.R_OK | constants.W_OK))) {
    throw new Error("Source file is missing or is not writable.");
  }

  if (await canAccess(targetPath, constants.F_OK)) {
    throw new Error(`Target already exists: ${toPosixRelative(libraryPath, targetPath)}`);
  }
}

function temporaryTargetPath(targetPath: string, jobId: string) {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `.${parsed.name}.naviclean-${jobId}${parsed.ext}`);
}

async function runFfmpegConversion(
  sourcePath: string,
  targetPath: string,
  options: ConversionCodecOptions & {
    duration: number | null;
    onProgress: (progress: number) => void;
  }
) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-map_metadata",
    "0",
    "-vn",
    ...ffmpegCodecArgs(options),
    "-progress",
    "pipe:1",
    "-nostats",
    targetPath
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const progress = parseFfmpegProgress(stdout, options.duration);

      if (progress !== null) {
        options.onProgress(progress);
      }

      if (stdout.length > 8_192) {
        stdout = stdout.slice(-4_096);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;

      if (stderr.length > 16_384) {
        stderr = stderr.slice(-8_192);
      }
    });
    child.on("error", (error) => {
      reject(new Error(formatFfmpegError(error, stderr, { sourcePath, targetPath })));
    });
    child.on("close", (code) => {
      if (code === 0) {
        options.onProgress(100);
        resolve();
        return;
      }

      const error = new Error(formatFfmpegError({ code, message: `ffmpeg exited with code ${code}` }, stderr, {
        sourcePath,
        targetPath
      }));
      reject(error);
    });
  });
}

function ffmpegCodecArgs({ quality, targetFormat }: ConversionCodecOptions) {
  if (targetFormat === "mp3") {
    return ["-codec:a", "libmp3lame", "-b:a", quality];
  }

  if (targetFormat === "m4a") {
    return ["-codec:a", "aac", "-b:a", quality, "-movflags", "+faststart"];
  }

  if (targetFormat === "opus") {
    return ["-codec:a", "libopus", "-b:a", quality, "-vbr", "on"];
  }

  if (targetFormat === "ogg") {
    return ["-codec:a", "libvorbis", "-b:a", quality];
  }

  if (targetFormat === "flac") {
    return ["-codec:a", "flac", "-compression_level", "8"];
  }

  return ["-codec:a", "pcm_s16le"];
}

export function parseFfmpegProgress(output: string, duration: number | null) {
  if (!duration || duration <= 0) {
    return null;
  }

  const lines = output.split(/\r?\n/).reverse();
  const progressDone = lines.some((line) => line.trim() === "progress=end");

  if (progressDone) {
    return 100;
  }

  for (const line of lines) {
    const [key, rawValue] = line.split("=");

    if (!rawValue) {
      continue;
    }

    if (key === "out_time_us" || key === "out_time_ms") {
      const value = Number(rawValue);

      if (Number.isFinite(value)) {
        return clampProgress(Math.round((value / 1_000_000 / duration) * 100));
      }
    }

    if (key === "out_time") {
      const value = parseFfmpegTime(rawValue);

      if (value !== null) {
        return clampProgress(Math.round((value / duration) * 100));
      }
    }
  }

  return null;
}

function parseFfmpegTime(value: string) {
  const match = value.match(/^(?<hours>\d+):(?<minutes>\d{2}):(?<seconds>\d{2}(?:\.\d+)?)$/);

  if (!match?.groups) {
    return null;
  }

  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes);
  const seconds = Number(match.groups.seconds);

  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(99, value));
}

function updateJobCounts(job: StoredAudioConvertJob) {
  job.completedCount = job.items.filter((item) => item.status === "completed").length;
  job.failedCount = job.items.filter((item) => item.status === "failed").length;
  job.pendingCount = job.items.filter((item) => item.status === "pending" || item.status === "converting").length;
}

function snapshotJob(job: StoredAudioConvertJob): AudioConvertJob {
  return {
    ...job,
    items: job.items.map((item) => ({
      completedAt: item.completedAt,
      error: item.error,
      outputSize: item.outputSize,
      progress: item.progress,
      sourceRelativePath: item.sourceRelativePath,
      sourceSize: item.sourceSize,
      startedAt: item.startedAt,
      status: item.status,
      targetRelativePath: item.targetRelativePath,
      trackId: item.trackId
    }))
  };
}

function normalizeExtension(value: string) {
  const extension = value.trim().toLowerCase();

  if (!extension) {
    return "";
  }

  return extension.startsWith(".") ? extension : `.${extension}`;
}

function assertTargetFormat(value: string): AudioConvertTargetFormat {
  if (targetFormats.includes(value as AudioConvertTargetFormat)) {
    return value as AudioConvertTargetFormat;
  }

  throw new Error("Choose MP3, FLAC, M4A, OPUS, OGG, or WAV as the target format.");
}

function assertQualityForTarget(targetFormat: AudioConvertTargetFormat, value: string): AudioConvertQuality {
  const quality = value as AudioConvertQuality;

  if (targetFormat === "flac" || targetFormat === "wav") {
    if (quality === "lossless") {
      return quality;
    }

    throw new Error("Choose Lossless quality for FLAC or WAV output.");
  }

  if (lossyQualities.has(quality)) {
    return quality;
  }

  throw new Error("Choose 128k, 192k, 256k, or 320k for lossy output.");
}

async function canAccess(filePath: string, mode: number) {
  try {
    await fs.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function audioConvertJobId() {
  return `navicvt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Conversion failed.";
}

export function formatFfmpegError(
  error: unknown,
  stderr: string,
  context: { sourcePath?: string; targetPath?: string } = {}
) {
  const execError = error as ExecFileError;
  const diagnostic = compactFfmpegDiagnostic(stderr, context);
  const summary = ffmpegFailureSummary(diagnostic);
  const exitCode = typeof execError.code === "number" ? `ffmpeg exit code: ${execError.code}.` : "";
  const spawnCode = typeof execError.code === "string" ? `ffmpeg error: ${execError.code}.` : "";
  const detail = diagnostic ? `ffmpeg details: ${diagnostic}` : errorMessage(error);

  return [summary, exitCode, spawnCode, detail].filter(Boolean).join(" ");
}

function compactFfmpegDiagnostic(stderr: string, context: { sourcePath?: string; targetPath?: string }) {
  const hiddenPaths = [context.sourcePath, context.targetPath]
    .filter((filePath): filePath is string => Boolean(filePath))
    .map((filePath) => path.resolve(filePath));

  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !hiddenPaths.some((filePath) => line.startsWith(filePath)))
    .map((line) => {
      let sanitized = line.replace(/\s*@\s*0x[0-9a-f]+/gi, "");

      for (const filePath of hiddenPaths) {
        sanitized = sanitized.replaceAll(filePath, path.basename(filePath));
      }

      return sanitized;
    })
    .slice(-4)
    .join(" ");
}

function ffmpegFailureSummary(diagnostic: string) {
  const normalized = diagnostic.toLowerCase();

  if (
    normalized.includes("invalid setup header") ||
    normalized.includes("header processing failed") ||
    normalized.includes("invalid data found when processing input") ||
    normalized.includes("could not find codec parameters") ||
    normalized.includes("end of file")
  ) {
    return "ffmpeg could not read this source audio stream, so the original file was left unchanged. The file is not necessarily empty; its audio header may be damaged, incomplete, or mislabeled. Replace or re-download it, then retry.";
  }

  if (
    normalized.includes("unknown encoder") ||
    normalized.includes("encoder not found") ||
    normalized.includes("requested output format") ||
    normalized.includes("not a suitable output format")
  ) {
    return "ffmpeg could not write the requested target format. Check the installed ffmpeg build and try another format.";
  }

  if (normalized.includes("permission denied")) {
    return "ffmpeg could not access one of the conversion files. Check the library permissions and try again.";
  }

  return "ffmpeg conversion failed.";
}
