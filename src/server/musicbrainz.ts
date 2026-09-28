import { httpCacheGet, httpCacheSet } from "./http-cache.js";
import { normalizeForMatch } from "./utils.js";

/**
 * MusicBrainz web service client. MusicBrainz allows one request per second per client
 * and requires a descriptive User-Agent, so every request goes through one spaced queue
 * and responses are cached in the database.
 */

export type MbArtistCredit = Array<{ name?: string; joinphrase?: string; artist?: { id?: string; name?: string } }>;

export type MbArtist = {
  id: string;
  name: string;
  "sort-name"?: string;
  disambiguation?: string;
  country?: string;
  type?: string;
  score?: number;
  "life-span"?: { begin?: string; end?: string; ended?: boolean };
  tags?: Array<{ name: string; count: number }>;
  genres?: Array<{ name: string; count: number }>;
};

export type MbReleaseGroup = {
  id: string;
  title: string;
  "primary-type"?: string | null;
  "secondary-types"?: string[];
  "first-release-date"?: string;
  "artist-credit"?: MbArtistCredit;
  disambiguation?: string;
  score?: number;
};

export type MbTrack = {
  id: string;
  number?: string;
  position?: number;
  title: string;
  length?: number | null;
  "artist-credit"?: MbArtistCredit;
  recording?: {
    id: string;
    title: string;
    length?: number | null;
    isrcs?: string[];
    "artist-credit"?: MbArtistCredit;
    disambiguation?: string;
  };
};

export type MbMedium = {
  position?: number;
  format?: string;
  title?: string;
  "track-count"?: number;
  tracks?: MbTrack[];
  track?: MbTrack[];
};

export type MbRelease = {
  id: string;
  title: string;
  status?: string;
  date?: string;
  country?: string;
  disambiguation?: string;
  "artist-credit"?: MbArtistCredit;
  "release-group"?: MbReleaseGroup;
  media?: MbMedium[];
  "track-count"?: number;
  score?: number;
  "cover-art-archive"?: { front?: boolean; artwork?: boolean };
  "label-info"?: Array<{ label?: { name?: string } }>;
};

export type MbRecording = {
  id: string;
  title: string;
  length?: number | null;
  score?: number;
  disambiguation?: string;
  "artist-credit"?: MbArtistCredit;
  isrcs?: string[];
  releases?: MbRelease[];
};

export class MusicBrainzError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const baseUrl = "https://musicbrainz.org/ws/2/";
const userAgent = "NaviClean/0.7 ( https://github.com/thedinz/NaviClean )";
const minimumSpacingMs = 1100;
const maxAttempts = 4;
const day = 1000 * 60 * 60 * 24;
export const musicBrainzCacheTtl = {
  search: day,
  entity: day * 7,
  browse: day * 2
};

let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let requestCount = 0;

export function musicBrainzRequestCount() {
  return requestCount;
}

/** GET a MusicBrainz resource, served from cache when fresh. `cached` reports whether the network was skipped. */
export async function musicBrainzGet<T>(
  resource: string,
  params: Record<string, string>,
  ttlMs: number
): Promise<{ data: T; cached: boolean }> {
  const url = new URL(resource, baseUrl);
  url.searchParams.set("fmt", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  const cacheKey = `mb:${url.pathname}?${[...url.searchParams.entries()].sort().map(([key, value]) => `${key}=${value}`).join("&")}`;
  const cached = httpCacheGet<T>(cacheKey);
  if (cached) {
    return { data: cached, cached: true };
  }

  const data = await spacedRequest(async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      try {
        requestCount += 1;
        response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": userAgent },
          signal: AbortSignal.timeout(20_000)
        });
      } catch {
        if (attempt < maxAttempts - 1) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        throw new MusicBrainzError("MusicBrainz could not be reached. Check the server's network connection.");
      }

      // MusicBrainz answers 503 when a client exceeds its rate; back off and retry.
      if ((response.status === 503 || response.status === 429) && attempt < maxAttempts - 1) {
        await delay(Number(response.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1));
        continue;
      }

      if (response.status === 404) {
        throw new MusicBrainzError("MusicBrainz has no entry for that identifier.", 404);
      }

      if (!response.ok) {
        throw new MusicBrainzError(`MusicBrainz returned HTTP ${response.status}.`, response.status);
      }

      return (await response.json()) as T;
    }

    throw new MusicBrainzError("MusicBrainz did not respond after several attempts.");
  });

  httpCacheSet(cacheKey, data, ttlMs);
  return { data, cached: false };
}

export async function searchMusicBrainzArtists(query: string, limit = 12) {
  const search = query.trim();
  if (!search) {
    return [];
  }

  const { data } = await musicBrainzGet<{ artists?: MbArtist[] }>(
    "artist",
    { query: search, limit: String(limit) },
    musicBrainzCacheTtl.search
  );
  return data.artists ?? [];
}

export async function getMusicBrainzArtist(artistId: string) {
  const { data } = await musicBrainzGet<MbArtist>(
    `artist/${encodeURIComponent(artistId)}`,
    { inc: "genres+tags" },
    musicBrainzCacheTtl.entity
  );
  return data;
}

/** Every release group credited to the artist, across pages. */
export async function browseMusicBrainzReleaseGroups(artistId: string, options: { fresh?: boolean } = {}) {
  const groups: MbReleaseGroup[] = [];
  const pageSize = 100;
  const ttl = options.fresh ? 1000 * 60 * 30 : musicBrainzCacheTtl.browse;

  for (let offset = 0; offset < 2000; offset += pageSize) {
    const { data } = await musicBrainzGet<{ "release-groups"?: MbReleaseGroup[]; "release-group-count"?: number }>(
      "release-group",
      { artist: artistId, limit: String(pageSize), offset: String(offset), inc: "artist-credits" },
      ttl
    );
    const page = data["release-groups"] ?? [];
    groups.push(...page);
    if (page.length < pageSize || groups.length >= (data["release-group-count"] ?? 0)) {
      break;
    }
  }

  return groups;
}

export async function browseMusicBrainzReleases(releaseGroupId: string) {
  const { data } = await musicBrainzGet<{ releases?: MbRelease[] }>(
    "release",
    { "release-group": releaseGroupId, inc: "media+artist-credits", limit: "100" },
    musicBrainzCacheTtl.browse
  );
  return data.releases ?? [];
}

export async function getMusicBrainzReleaseGroup(releaseGroupId: string) {
  const { data } = await musicBrainzGet<MbReleaseGroup>(
    `release-group/${encodeURIComponent(releaseGroupId)}`,
    { inc: "artist-credits" },
    musicBrainzCacheTtl.entity
  );
  return data;
}

export async function getMusicBrainzRelease(releaseId: string) {
  const { data } = await musicBrainzGet<MbRelease>(
    `release/${encodeURIComponent(releaseId)}`,
    { inc: "recordings+artist-credits+isrcs+release-groups+media+labels" },
    musicBrainzCacheTtl.entity
  );
  return data;
}

export async function getMusicBrainzRecording(recordingId: string) {
  const { data } = await musicBrainzGet<MbRecording>(
    `recording/${encodeURIComponent(recordingId)}`,
    { inc: "artist-credits+isrcs" },
    musicBrainzCacheTtl.entity
  );
  return data;
}

export async function searchMusicBrainzReleases(
  hints: { artist?: string; album: string },
  limit = 5
): Promise<{ releases: MbRelease[]; cached: boolean }> {
  const query = [
    `release:(${luceneTerm(hints.album)})`,
    hints.artist ? `artist:(${luceneTerm(hints.artist)})` : ""
  ].filter(Boolean).join(" AND ");
  const { data, cached } = await musicBrainzGet<{ releases?: MbRelease[] }>(
    "release",
    { query, limit: String(limit) },
    musicBrainzCacheTtl.search
  );
  return { releases: data.releases ?? [], cached };
}

export async function searchMusicBrainzRecordings(
  hints: { artist?: string; title: string; album?: string },
  limit = 8
): Promise<{ recordings: MbRecording[]; cached: boolean }> {
  const query = [
    `recording:(${luceneTerm(hints.title)})`,
    hints.artist ? `artist:(${luceneTerm(hints.artist)})` : "",
    hints.album ? `release:(${luceneTerm(hints.album)})` : ""
  ].filter(Boolean).join(" AND ");
  const { data, cached } = await musicBrainzGet<{ recordings?: MbRecording[] }>(
    "recording",
    { query, limit: String(limit) },
    musicBrainzCacheTtl.search
  );
  return { recordings: data.recordings ?? [], cached };
}

export function artistCreditName(credit: MbArtistCredit | undefined) {
  return (credit ?? []).map((part) => `${part.name ?? part.artist?.name ?? ""}${part.joinphrase ?? ""}`).join("").trim();
}

export function artistCreditIds(credit: MbArtistCredit | undefined) {
  return (credit ?? []).map((part) => part.artist?.id).filter((id): id is string => Boolean(id));
}

export function releaseYear(date: string | undefined) {
  const year = Number(date?.match(/^\d{4}/)?.[0]);
  return Number.isInteger(year) && year > 0 ? year : null;
}

export function mediumTracks(medium: MbMedium) {
  return medium.tracks ?? medium.track ?? [];
}

export function releaseTrackCount(release: MbRelease) {
  return (release.media ?? []).reduce((total, medium) => total + (medium["track-count"] ?? mediumTracks(medium).length), 0) ||
    release["track-count"] ||
    0;
}

/** Album type label in the style the organizer already uses (Album, Single, EP, Compilation, Live…). */
export function releaseGroupTypeLabel(group: MbReleaseGroup | undefined) {
  const secondary = group?.["secondary-types"]?.[0];
  return secondary || group?.["primary-type"] || "Album";
}

/**
 * Picks the edition a user most likely means: official releases first, then digital or CD
 * media, worldwide/US/UK releases, the most common track count, and the earliest date.
 */
export function preferredRelease(releases: MbRelease[]) {
  if (releases.length === 0) {
    return null;
  }

  const trackCounts = new Map<number, number>();
  for (const release of releases) {
    if (release.status === "Official") {
      const count = releaseTrackCount(release);
      trackCounts.set(count, (trackCounts.get(count) ?? 0) + 1);
    }
  }
  const commonTrackCount = [...trackCounts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0];

  const scored = releases.map((release) => {
    const formats = (release.media ?? []).map((medium) => medium.format ?? "");
    let score = 0;
    if (release.status === "Official") score += 100;
    if (release.status === "Bootleg" || release.status === "Pseudo-Release") score -= 100;
    if (formats.some((format) => format === "Digital Media")) score += 20;
    else if (formats.some((format) => format === "CD")) score += 15;
    if (release.country === "XW") score += 12;
    else if (release.country === "US" || release.country === "GB") score += 8;
    if (commonTrackCount && releaseTrackCount(release) === commonTrackCount) score += 25;
    if (release.date) score += 5;
    return { release, score };
  });

  scored.sort((left, right) =>
    right.score - left.score ||
    (left.release.date || "9999").localeCompare(right.release.date || "9999")
  );
  return scored[0].release;
}

export function coverArtUrl(kind: "release" | "release-group", id: string, size: 250 | 500 | 1200 = 500) {
  return `https://coverartarchive.org/${kind}/${encodeURIComponent(id)}/front-${size}`;
}

/** Fetches cover art bytes from the Cover Art Archive, trying the release first and then its group. */
export async function fetchCoverArt(releaseId: string | undefined, releaseGroupId: string | undefined, size: 250 | 500 | 1200 = 500) {
  const urls = [
    releaseId ? coverArtUrl("release", releaseId, size) : null,
    releaseGroupId ? coverArtUrl("release-group", releaseGroupId, size) : null
  ].filter((url): url is string => Boolean(url));

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000)
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.startsWith("image/")) {
        return { contentType, data: Buffer.from(await response.arrayBuffer()) };
      }
    } catch {
      // Try the next source; artwork is optional.
    }
  }

  return null;
}

export function textSimilarity(left: string, right: string) {
  const leftTokens = new Set(normalizeForMatch(left, { removeBracketedText: false }).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeForMatch(right, { removeBracketedText: false }).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function luceneTerm(value: string) {
  const cleaned = value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? `"${cleaned}"` : '""';
}

async function spacedRequest<T>(operation: () => Promise<T>): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  queue = queue.then(async () => {
    const waitMs = Math.max(0, minimumSpacingMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) {
      await delay(waitMs);
    }
    try {
      resolveResult(await operation());
    } catch (error) {
      rejectResult(error);
    } finally {
      lastRequestAt = Date.now();
    }
  });

  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
