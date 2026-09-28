import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CatalogProviderId, TrackFile } from "../shared/types.js";
import { execute } from "./db.js";
import { buildDuplicateKey } from "./matching.js";
import type { PrivateSettings } from "./settings.js";
import { trackKeepMetadataTagsForSpotifyTrack } from "./trackkeep.js";
import { sha1 } from "./utils.js";

/**
 * Media plumbing shared by every download source: yt-dlp invocation, the global YouTube
 * pacing queue, staging directories, Opus/MP3 normalization, and tag/artwork writing.
 */

/** Spotify-shaped track description, kept for TrackKeep-compatible tagging. */
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

export type YtDlpSearchEntry = {
  channel?: string;
  duration?: number;
  id?: string;
  title?: string;
  uploader?: string;
  url?: string;
  view_count?: number;
  webpage_url?: string;
};

type YtDlpSearchResult = {
  entries?: YtDlpSearchEntry[];
};

type ExecFileError = Error & {
  code?: number | string;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
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

export type StagedAudioEncoding = {
  bitRate: number | null;
  codecName: string;
  durationSeconds: number | null;
};

const execFileAsync = promisify(execFile);
const defaultProviderSearchTimeoutMs = 20_000;
const defaultProviderDownloadTimeoutMs = 600_000;
const youtubeDownloadSpacingMs = 10_000;
const youtubeDownloadBatchSize = 5;
const youtubeDownloadBatchCooldownMs = 120_000;
const stagingRootSegments = [".naviclean", "tmp", "provider-downloads"];
const defaultYtDlpJsRuntime = "node";

let youtubeDownloadQueue: Promise<void> = Promise.resolve();
let youtubeDownloadsSinceCooldown = 0;
let lastYoutubeDownloadFinishedAt = 0;

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

export async function runYtDlpSearch(searchUrl: string) {
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

export async function runYtDlp({
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
    // Report the selected source stream so quality floors judge the original, not our re-encode.
    "--print", `video:${sourceInfoPrefix}%(acodec)s|%(abr)s`,
    "--print", "after_move:filepath", "--output", outputTemplate, downloadUrl
  ];
}

const sourceInfoPrefix = "NCSOURCE|";

/** Codec and bitrate of the stream yt-dlp selected, parsed from its --print output. */
export function parseYtDlpSourceInfo(stdout: string) {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(sourceInfoPrefix));
  if (!line) {
    return { codec: null, bitrateKbps: null };
  }
  const [, codec, abr] = line.split("|");
  const bitrate = Number(abr);
  return {
    codec: codec && codec !== "NA" && codec !== "none" ? codec : null,
    bitrateKbps: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null
  };
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

export async function probeStagedAudioEncoding(filePath: string): Promise<StagedAudioEncoding> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 1024 * 1024, timeout: 30_000 }
  );
  const probe = JSON.parse(stdout.toString()) as {
    format?: { bit_rate?: string; duration?: string };
    streams?: Array<{ bit_rate?: string; codec_name?: string; codec_type?: string; duration?: string }>;
  };
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const bitrate = Number(audio?.bit_rate ?? probe.format?.bit_rate);
  const duration = Number(audio?.duration ?? probe.format?.duration);
  return {
    bitRate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    codecName: audio?.codec_name?.toLowerCase() ?? "",
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null
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

function isProviderFormatFailure(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return [
    "audio conversion failed", "could not write header", "encoder", "ffmpeg",
    "invalid audio format", "libopus", "postprocessing", "requested audio format",
    "unsupported codec", "provider audio normalization failed"
  ].some((needle) => message.includes(needle));
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

/** Downloads cover art next to a staged file; returns null when artwork is unavailable. */
export async function downloadCoverImage(directory: string, fileBase: string, imageUrl: string | null) {
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
      headers: { "User-Agent": "NaviClean/0.7 ( https://github.com/thedinz/NaviClean )" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000)
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
    targetSource: "spotify",
    metadataConfidence: "spotify",
    identification: {
      status: "user-confirmed",
      source: "spotify",
      message: "Spotify metadata was selected for this provider download.",
      spotifyTrackId: track.id,
      spotifyAlbumId: track.albumId
    }
  };
}

export async function createDownloadStagingDirectory(libraryPath: string) {
  const stagingRoot = path.join(libraryPath, ...stagingRootSegments);
  const stagingDirectory = path.join(stagingRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  await fs.mkdir(stagingDirectory, {
    recursive: true
  });

  return stagingDirectory;
}

export async function nextAvailableFilePath(filePath: string) {
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

export async function matchingOutputPaths(directory: string, fileBase: string) {
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

export async function findDownloadedPath({
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

export function recordDownloadProvenance(entry: {
  album: string;
  artists: string[];
  bytesWritten: number;
  destinationPath: string;
  format: ProviderDownloadFormat;
  providerId: CatalogProviderId;
  quality: ProviderDownloadQuality;
  relativePath: string;
  sourceUrl: string;
  trackKey: string;
  trackName: string;
}) {
  const now = new Date().toISOString();
  execute("INSERT INTO download_log (data, created_at) VALUES (?, ?)", JSON.stringify({ ...entry, confirmedAt: now }), now);
}

export function assertProvider(value: string): CatalogProviderId {
  if (value === "youtube" || value === "jiosaavn") {
    return value;
  }

  throw new Error("Choose YouTube or JioSaavn.");
}

export function resolveProviderSource(providerId: CatalogProviderId, input: string) {
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

/** Works out which provider a pasted URL belongs to, validating it along the way. */
export function providerForUrl(input: string): CatalogProviderId {
  const url = parseHttpsUrl(input.trim());
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith("youtube.com") || hostname === "youtu.be") {
    assertYoutubeUrl(url);
    return "youtube";
  }
  if (hostname.endsWith("jiosaavn.com") || hostname.endsWith("saavn.com")) {
    assertJioSaavnSongUrl(url);
    return "jiosaavn";
  }
  throw new Error("Paste a YouTube video or JioSaavn song link.");
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
  const hostname = url.hostname.toLowerCase();
  const isYoutube =
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "music.youtube.com" ||
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
  const hostname = url.hostname.toLowerCase();

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

function sanitizeYoutubeVideoId(value: string) {
  const match = value.match(/^[A-Za-z0-9_-]{6,20}$/);

  return match?.[0] ?? null;
}

export function extractYoutubeVideoIdFromValue(value: string) {
  const directId = sanitizeYoutubeVideoId(value);

  if (directId) {
    return directId;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    if (hostname === "youtu.be") {
      return sanitizeYoutubeVideoId(url.pathname.replace(/^\//, ""));
    }

    if (hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "m.youtube.com" || hostname === "music.youtube.com") {
      return sanitizeYoutubeVideoId(url.searchParams.get("v") ?? "");
    }
  } catch {
    return null;
  }

  return null;
}

export function splitProviderArtists(value: string) {
  return value
    .split(/,|&|;|\band\b/i)
    .map((artist) => artist.trim())
    .filter(Boolean);
}

export function stripHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function ytDlpJsRuntimeArgs() {
  const configuredRuntime = process.env.NAVICLEAN_YTDLP_JS_RUNTIME?.trim();
  const runtime =
    configuredRuntime === "none" ? "" : configuredRuntime || defaultYtDlpJsRuntime;

  return runtime ? ["--js-runtimes", runtime] : [];
}

export async function commandAvailable(command: string, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
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

  if (execError.code === "ENOENT") {
    return "yt-dlp is not installed or not on PATH. Use the Docker image, or install yt-dlp.";
  }

  return [
    fallbackMessage,
    exitCode,
    lastDiagnosticLine ? `yt-dlp output: ${formatYtDlpDiagnosticLine(lastDiagnosticLine)}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatFfmpegError(error: unknown) {
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

export function youtubeDownloadDelayMs({
  downloadsSinceCooldown,
  lastFinishedAt,
  now
}: {
  downloadsSinceCooldown: number;
  lastFinishedAt: number;
  now: number;
}) {
  if (!lastFinishedAt) {
    return 0;
  }

  const requiredDelay = downloadsSinceCooldown >= youtubeDownloadBatchSize
    ? youtubeDownloadBatchCooldownMs
    : youtubeDownloadSpacingMs;
  return Math.max(0, requiredDelay - (now - lastFinishedAt));
}

/** Serializes YouTube downloads globally: 10 s between tracks and a 2 min pause after every 5. */
export async function runQueuedYoutubeDownload<T>(operation: () => Promise<T>) {
  const queued = youtubeDownloadQueue.then(async () => {
    const cooldownDue = youtubeDownloadsSinceCooldown >= youtubeDownloadBatchSize;
    const waitMs = youtubeDownloadDelayMs({
      downloadsSinceCooldown: youtubeDownloadsSinceCooldown,
      lastFinishedAt: lastYoutubeDownloadFinishedAt,
      now: Date.now()
    });

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (cooldownDue) {
      youtubeDownloadsSinceCooldown = 0;
    }

    try {
      return await operation();
    } finally {
      youtubeDownloadsSinceCooldown += 1;
      lastYoutubeDownloadFinishedAt = Date.now();
    }
  });

  youtubeDownloadQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
