import path from "node:path";
import type { CatalogProviderCandidate, CatalogProviderId, DownloadTrack } from "../../shared/types.js";
import {
  commandAvailable,
  extractYoutubeVideoIdFromValue,
  findDownloadedPath,
  matchingOutputPaths,
  parseYtDlpSourceInfo,
  resolveProviderSource,
  runQueuedYoutubeDownload,
  runYtDlp,
  runYtDlpSearch,
  splitProviderArtists,
  stripHtmlEntities,
  type ProviderDownloadFormat,
  type ProviderDownloadQuality,
  type YtDlpSearchEntry
} from "../providers.js";
import { scoreCandidate, type CandidateFacts } from "./scoring.js";

/**
 * A place audio can come from. Everything source-specific (searching, fetching the raw
 * stream) lives behind this interface; scoring, verification, tagging, and import are shared.
 */
export interface DownloadSource {
  id: CatalogProviderId;
  label: string;
  checkAvailability(): Promise<{ available: boolean; message: string }>;
  search(track: DownloadTrack, limit: number): Promise<CatalogProviderCandidate[]>;
  fetch(
    candidate: CatalogProviderCandidate,
    options: { stagingDirectory: string; fileBase: string; format: ProviderDownloadFormat; quality: ProviderDownloadQuality }
  ): Promise<FetchedAudio>;
}

export type FetchedAudio = {
  stagedPath: string;
  sourceCodec: string | null;
  sourceBitrateKbps: number | null;
};

const youtubeConfidentScore = 92;
const minResultsPerQuery = 5;
const maxResultsPerQuery = 15;

const ytDlpFetch: DownloadSource["fetch"] = async (candidate, { stagingDirectory, fileBase, format, quality }) => {
  const { sourceUrl } = resolveProviderSource(candidate.providerId, candidate.url);
  const outputTemplate = path.join(stagingDirectory, `${fileBase}.%(ext)s`);
  const beforePaths = await matchingOutputPaths(stagingDirectory, fileBase);
  const run = () => runYtDlp({ downloadUrl: sourceUrl, format, outputTemplate, quality });
  const stdout = candidate.providerId === "youtube" ? await runQueuedYoutubeDownload(run) : await run();
  const stagedPath = await findDownloadedPath({ beforePaths, format, outputTemplate, stdout, targetDirectory: stagingDirectory });
  const source = parseYtDlpSourceInfo(stdout);
  return { stagedPath, sourceCodec: source.codec, sourceBitrateKbps: source.bitrateKbps };
};

let ytDlpAvailability: Promise<boolean> | null = null;

function ytDlpAvailable() {
  ytDlpAvailability ??= commandAvailable("yt-dlp");
  return ytDlpAvailability;
}

export const youtubeSource: DownloadSource = {
  id: "youtube",
  label: "YouTube",
  async checkAvailability() {
    const available = await ytDlpAvailable();
    return {
      available,
      message: available ? "yt-dlp is installed." : "yt-dlp is not installed or not on PATH."
    };
  },
  async search(track, limit) {
    const perQuery = Math.min(Math.max(limit, minResultsPerQuery), maxResultsPerQuery);
    const byId = new Map<string, CatalogProviderCandidate>();

    for (const query of youtubeQueries(track)) {
      const result = await runYtDlpSearch(`ytsearch${perQuery}:${query}`);
      const entries = Array.isArray(result.entries) ? result.entries : [];
      entries.forEach((entry, rank) => {
        const candidate = youtubeCandidate(track, entry, rank);
        const existing = candidate ? byId.get(candidate.id) : undefined;
        if (candidate && (!existing || candidate.score.overall > existing.score.overall)) {
          byId.set(candidate.id, candidate);
        }
      });

      const best = [...byId.values()].sort((left, right) => right.score.overall - left.score.overall)[0];
      if (byId.size >= limit && best && best.score.overall >= youtubeConfidentScore && best.flags?.includes("topic-channel")) {
        break;
      }
    }

    return [...byId.values()].sort((left, right) => right.score.overall - left.score.overall);
  },
  fetch: ytDlpFetch
};

export const jioSaavnSource: DownloadSource = {
  id: "jiosaavn",
  label: "JioSaavn",
  async checkAvailability() {
    const available = await ytDlpAvailable();
    return {
      available,
      message: available ? "Searches JioSaavn's public catalog; downloads through yt-dlp." : "yt-dlp is required for JioSaavn downloads."
    };
  },
  async search(track, limit) {
    const url = new URL("https://www.jiosaavn.com/api.php");
    url.search = new URLSearchParams({
      __call: "autocomplete.get",
      _format: "json",
      _marker: "0",
      query: [track.title, track.artists.slice(0, 2).join(" ")].filter(Boolean).join(" ")
    }).toString();

    const response = await fetch(url, {
      headers: { "User-Agent": "NaviClean/0.7" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`JioSaavn search returned HTTP ${response.status}.`);
    }

    type Entry = {
      duration?: string;
      id?: string;
      more_info?: { album?: string; duration?: string; primary_artists?: string; singers?: string };
      perma_url?: string;
      subtitle?: string;
      title?: string;
      url?: string;
    };
    const body = (await response.json()) as { songs?: { data?: Entry[] } };
    const entries = Array.isArray(body.songs?.data) ? body.songs.data : [];

    return entries.slice(0, limit).flatMap((entry, rank) => {
      const link = entry.perma_url || entry.url;
      if (!link || !entry.title) {
        return [];
      }
      const title = stripHtmlEntities(entry.title);
      const artists = splitProviderArtists(
        stripHtmlEntities(entry.more_info?.primary_artists || entry.more_info?.singers || entry.subtitle || "")
      );
      const seconds = Number(entry.more_info?.duration ?? entry.duration);
      const album = stripHtmlEntities(entry.more_info?.album ?? "");
      const facts: CandidateFacts = {
        title,
        artists,
        album: album || undefined,
        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
        rank
      };
      return [toCandidate("jiosaavn", `jiosaavn:${entry.id ?? rank}`, link, track, facts)];
    });
  },
  fetch: ytDlpFetch
};

export const downloadSources: DownloadSource[] = [youtubeSource, jioSaavnSource];

export function sourceById(id: CatalogProviderId) {
  const source = downloadSources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new Error(`Unknown download source: ${id}`);
  }
  return source;
}

/** Test seam: swaps the registered sources, returning a function that restores the originals. */
export function replaceDownloadSourcesForTests(sources: DownloadSource[]) {
  const original = downloadSources.splice(0, downloadSources.length, ...sources);
  return () => {
    downloadSources.splice(0, downloadSources.length, ...original);
  };
}

/** Builds a scored candidate for a link the user pasted during review. */
export function candidateFromUrl(track: DownloadTrack, providerId: CatalogProviderId, url: string): CatalogProviderCandidate {
  resolveProviderSource(providerId, url);
  const videoId = providerId === "youtube" ? extractYoutubeVideoIdFromValue(url) : null;
  const facts: CandidateFacts = { title: track.title, artists: track.artists, rank: 0 };
  const candidate = toCandidate(providerId, videoId ? `youtube:${videoId}` : `${providerId}:${url}`, url, track, facts);
  return { ...candidate, flags: ["manual-url"], title: "Link supplied during review" };
}

function youtubeQueries(track: DownloadTrack) {
  const artists = track.artists.slice(0, 2).join(" ") || track.albumArtist;
  const albumPart = track.album && normalizedDiffers(track.album, track.title) ? track.album : "";
  return unique([
    [track.title, artists, albumPart].filter(Boolean).join(" "),
    // Topic uploads (the label's release audio) carry this phrase in their description.
    `${artists} ${track.title} "Auto-generated by YouTube"`,
    `${artists} ${track.title} official audio`
  ]);
}

function youtubeCandidate(track: DownloadTrack, entry: YtDlpSearchEntry, rank: number) {
  const videoId = extractYoutubeVideoIdFromValue(String(entry.id ?? entry.url ?? entry.webpage_url ?? ""));
  if (!videoId || !entry.title) {
    return null;
  }

  const channel = stripHtmlEntities(String(entry.channel ?? entry.uploader ?? ""));
  const facts: CandidateFacts = {
    title: stripHtmlEntities(String(entry.title)),
    artists: [channel.replace(/\s-\sTopic$/i, "")].filter(Boolean),
    channel,
    durationMs: typeof entry.duration === "number" ? Math.round(entry.duration * 1000) : undefined,
    viewCount: typeof entry.view_count === "number" ? entry.view_count : undefined,
    rank
  };
  return toCandidate("youtube", `youtube:${videoId}`, `https://www.youtube.com/watch?v=${videoId}`, track, facts);
}

function toCandidate(
  providerId: CatalogProviderId,
  id: string,
  url: string,
  track: DownloadTrack,
  facts: CandidateFacts
): CatalogProviderCandidate {
  const { score, flags } = scoreCandidate(track, facts);
  const candidate: CatalogProviderCandidate = {
    artists: facts.artists,
    id,
    providerId,
    score,
    title: facts.title,
    url,
    verified: false,
    flags
  };
  if (facts.channel) candidate.channel = facts.channel;
  if (facts.album) candidate.album = facts.album;
  if (typeof facts.durationMs === "number") candidate.durationMs = facts.durationMs;
  return candidate;
}

function normalizedDiffers(left: string, right: string) {
  return left.trim().toLowerCase() !== right.trim().toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}
