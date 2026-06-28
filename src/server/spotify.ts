import type {
  SpotifyAlbumDetail,
  SpotifyAlbumSummary,
  SpotifyArtistDiscography,
  SpotifyArtistSummary,
  SpotifyCatalogDownloadPlan,
  SpotifyCatalogMatch,
  SpotifyTestResult,
  SpotifyTrackSummary,
  TrackFile
} from "../shared/types.js";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { buildDuplicateKey } from "./matching.js";
import { getDataDir, type PrivateSettings } from "./settings.js";
import { normalizeForMatch, sha1 } from "./utils.js";

type SpotifyImage = {
  height?: number | null;
  url: string;
  width?: number | null;
};

type SpotifyArtist = {
  external_urls?: { spotify?: string };
  id: string;
  images?: SpotifyImage[];
  name: string;
};

type SpotifyAlbum = {
  album_type: string;
  artists: SpotifyArtist[];
  external_urls?: { spotify?: string };
  id: string;
  images?: SpotifyImage[];
  name: string;
  release_date: string;
  total_tracks: number;
};

type SpotifyTrack = {
  album?: SpotifyAlbum;
  artists?: SpotifyArtist[];
  disc_number: number;
  duration_ms: number;
  explicit: boolean;
  external_ids?: {
    isrc?: string;
  };
  external_urls?: { spotify?: string };
  id: string;
  name: string;
  track_number: number;
};

type SpotifyToken = {
  accessToken: string;
  expiresAt: number;
  key: string;
};

type SpotifyOrganizeTrack = {
  album: string;
  albumArtist: string;
  albumId: string;
  albumReleaseDate: string;
  albumTotalTracks: number | null;
  albumType: string;
  artists: string[];
  discNumber: number | null;
  duration: number | null;
  explicit: boolean;
  id: string;
  isrc: string | null;
  name: string;
  spotifyUrl: string;
  trackNumber: number | null;
};

type SpotifyOrganizeCache = {
  matches: Record<string, SpotifyOrganizeCacheEntry>;
  updatedAt: string;
  version: 3;
};

type SpotifyOrganizeCacheEntry = {
  matchedAt: string;
  score?: number;
  status: "matched" | "none";
  track?: SpotifyOrganizeTrack;
};

type SpotifyOrganizeHint = {
  album: string;
  albumArtist: string;
  artist: string;
  discNumber: number | null;
  duration: number | null;
  isrc: string | null;
  title: string;
  trackNumber: number | null;
  year: number | null;
};

type SpotifyOrganizeScore = {
  exactIsrc: boolean;
  hint: SpotifyOrganizeHint;
  score: number;
  track: SpotifyOrganizeTrack;
};

export type SpotifyOrganizeEnrichmentOptions = {
  includeSummaryWarning?: boolean;
  lookupMissing?: boolean;
  useCache?: boolean;
};

let cachedToken: SpotifyToken | null = null;
let requestWindowStartedAt = 0;
let requestWindowCount = 0;
type SqliteDatabase = {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

const require = createRequire(import.meta.url);
let spotifyOrganizeDatabase: SqliteDatabase | null = null;

const spotifyOrganizeJsonCachePath = path.join(getDataDir(), "spotify-organize-cache.json");
const spotifyOrganizeDatabasePath = path.join(getDataDir(), "spotify-organize.sqlite");
const spotifyOrganizeCacheVersion = 3;
const spotifyOrganizeLegacyCacheVersion = 1;
const spotifyOrganizeNoMatchTtlMs = 7 * 24 * 60 * 60 * 1000;
const spotifyOrganizeMatchTtlMs = 90 * 24 * 60 * 60 * 1000;

export async function testSpotifyConnection(
  settings: PrivateSettings,
  override: Partial<PrivateSettings["catalog"]["spotify"]> = {}
): Promise<SpotifyTestResult> {
  const credentials = spotifyCredentials(settings, override);

  try {
    await spotifyRequest<{ artists: { items: SpotifyArtist[] } }>(
      settings,
      credentials,
      "/v1/search",
      {
        limit: "1",
        q: "Miles Davis",
        type: "artist"
      }
    );
    return { ok: true, message: "Connected to Spotify catalog" };
  } catch (error) {
    return {
      ok: false,
      message: (error as Error).message || "Could not connect to Spotify catalog"
    };
  }
}

export async function searchSpotifyArtists(
  settings: PrivateSettings,
  query: string
) {
  const search = query.trim();

  if (!search) {
    return [];
  }

  const response = await spotifyRequest<{ artists: { items: SpotifyArtist[] } }>(
    settings,
    spotifyCredentials(settings),
    "/v1/search",
    {
      limit: "8",
      market: settings.catalog.spotify.market,
      q: search,
      type: "artist"
    }
  );

  return response.artists.items.map(spotifyArtistSummary);
}

export async function matchLibraryArtistsToSpotify(
  settings: PrivateSettings,
  artists: Array<{ id: string; name: string }>,
  limit = 12
) {
  const matches: SpotifyCatalogMatch[] = [];

  for (const artist of artists.slice(0, Math.max(1, Math.min(50, limit)))) {
    const [match] = await searchSpotifyArtists(settings, artist.name);
    const artistKey = normalizeForMatch(artist.name, { removeBracketedText: false });
    const matchKey = normalizeForMatch(match?.name ?? "", { removeBracketedText: false });
    const accepted = Boolean(match && artistKey === matchKey);

    matches.push({
      localArtistId: artist.id,
      localArtistName: artist.name,
      spotifyArtist: accepted ? match : null,
      message: accepted ? "Matched" : "Search and choose an artist"
    });
  }

  return matches;
}

export async function getSpotifyArtistDiscography(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  artistId: string
): Promise<SpotifyArtistDiscography> {
  const artist = await spotifyRequest<SpotifyArtist>(
    settings,
    spotifyCredentials(settings),
    `/v1/artists/${encodeURIComponent(artistId)}`
  );
  const albums = await getAllSpotifyPages<SpotifyAlbum>(
    settings,
    `/v1/artists/${encodeURIComponent(artistId)}/albums`,
    {
      include_groups: "album,single,compilation",
      limit: "50",
      market: settings.catalog.spotify.market
    }
  );
  const uniqueAlbums = uniqueSpotifyAlbums(albums);

  return {
    artist: spotifyArtistSummary(artist),
    albums: uniqueAlbums.map((album) => ({
      ...spotifyAlbumSummary(album),
      localTrackCount: localAlbumTrackCount(localTracks, artist.name, album.name)
    }))
  };
}

export async function getSpotifyAlbumDetail(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string
): Promise<SpotifyAlbumDetail> {
  const album = await spotifyRequest<SpotifyAlbum & { tracks: { items: SpotifyTrack[] } }>(
    settings,
    spotifyCredentials(settings),
    `/v1/albums/${encodeURIComponent(albumId)}`,
    {
      market: settings.catalog.spotify.market
    }
  );
  const artist = album.artists[0] ?? {
    id: "",
    name: "Unknown Artist"
  };
  const albumArtist = artist.name;
  const albumName = album.name;
  const tracks = album.tracks.items.map((track) =>
    spotifyTrackSummary(track, localTracks, albumArtist, albumName)
  );

  return {
    ...spotifyAlbumSummary(album),
    artist: spotifyArtistSummary(artist),
    tracks,
    localTrackCount: tracks.filter((track) => track.present).length
  };
}

export async function buildSpotifyDownloadPlan(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string,
  trackIds?: string[]
): Promise<SpotifyCatalogDownloadPlan> {
  const album = await getSpotifyAlbumDetail(settings, localTracks, albumId);
  const selectedIds = new Set(trackIds?.filter(Boolean) ?? []);
  const selectedTracks = selectedIds.size
    ? album.tracks.filter((track) => selectedIds.has(track.id))
    : album.tracks.filter((track) => !track.present);

  return {
    album,
    selectedTracks,
    supportedProviders: ["youtube", "jiosaavn"],
    warnings: [
      "Spotify is used for metadata only. Provider downloads must be limited to content you are authorized to download."
    ]
  };
}

export async function enrichTracksWithSpotifyOrganizeMetadata(
  settings: PrivateSettings,
  tracks: TrackFile[],
  options: SpotifyOrganizeEnrichmentOptions = {}
) {
  const useCache = options.useCache ?? true;
  const lookupMissing = options.lookupMissing ?? true;
  const includeSummaryWarning = options.includeSummaryWarning ?? true;
  const warnings: string[] = [];
  const credentials = spotifyCredentials(settings);
  const eligibleTracks = tracks.filter(spotifyOrganizeTrackIsEligible);

  if (eligibleTracks.length === 0) {
    return {
      tracks,
      warnings
    };
  }

  if (!credentials.clientId || !credentials.clientSecret) {
    if (includeSummaryWarning) {
      warnings.push("Spotify organize matching skipped because Spotify client credentials are not configured.");
    }
    return {
      tracks,
      warnings
    };
  }

  const cache = useCache ? await readSpotifyOrganizeCache() : emptySpotifyOrganizeCache();
  const enrichedById = new Map<string, TrackFile>();
  let checked = 0;
  let cached = 0;
  let matched = 0;
  let noMatch = 0;
  let failed = 0;
  let aborted = false;

  for (const track of eligibleTracks) {
    const cacheKeys = spotifyOrganizeCacheKeys(settings, track);
    const hints = spotifyOrganizeHints(track);
    const freshCacheEntry = firstFreshSpotifyOrganizeCacheEntry(cache, cacheKeys, hints);

    checked += 1;

    if (freshCacheEntry) {
      cached += 1;
      if (freshCacheEntry.status === "matched" && freshCacheEntry.track) {
        enrichedById.set(track.id, trackFileFromSpotifyOrganizeTrack(track, freshCacheEntry.track));
        matched += 1;
      } else {
        noMatch += 1;
      }
      continue;
    }

    if (!lookupMissing) {
      noMatch += 1;
      continue;
    }

    try {
      const result = await findSpotifyOrganizeTrack(settings, track);
      const entry = {
        matchedAt: new Date().toISOString(),
        score: result?.score,
        status: result ? "matched" : "none",
        track: result?.track
      } satisfies SpotifyOrganizeCacheEntry;

      for (const cacheKey of cacheKeys) {
        cache.matches[cacheKey] = entry;
      }

      if (result) {
        enrichedById.set(track.id, trackFileFromSpotifyOrganizeTrack(track, result.track));
        matched += 1;
      } else {
        noMatch += 1;
      }
    } catch (error) {
      failed += 1;
      warnings.push(`Spotify organize matching stopped after ${checked.toLocaleString()} track(s): ${(error as Error).message}`);
      aborted = true;
      break;
    }
  }

  if (useCache && (matched > 0 || noMatch > 0)) {
    await writeSpotifyOrganizeCache(cache);
  }

  if (!aborted && includeSummaryWarning) {
    warnings.push(
      [
        "Spotify organize matching",
        `${checked.toLocaleString()} checked`,
        `${matched.toLocaleString()} matched`,
        `${cached.toLocaleString()} cached`,
        `${noMatch.toLocaleString()} local fallback`
      ].join("; ")
    );
  } else if (failed > 0 && includeSummaryWarning) {
    warnings.push(`${failed.toLocaleString()} Spotify organize lookup failed before the local fallback was used.`);
  }

  return {
    tracks: tracks.map((track) => enrichedById.get(track.id) ?? track),
    warnings
  };
}

async function spotifyRequest<T>(
  settings: PrivateSettings,
  credentials: PrivateSettings["catalog"]["spotify"],
  endpoint: string,
  params: Record<string, string> = {}
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await throttleSpotifyRequest(settings);
    const token = await getSpotifyAccessToken(credentials);
    const url = new URL(endpoint, "https://api.spotify.com");

    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 429 && attempt < 3) {
      await waitForSpotifyRetry(response);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Spotify catalog returned HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  throw new Error("Spotify catalog rate limit did not clear in time.");
}

async function getAllSpotifyPages<T>(
  settings: PrivateSettings,
  endpoint: string,
  params: Record<string, string>
) {
  const items: T[] = [];
  let nextUrl: string | null = endpoint;
  let nextParams: Record<string, string> = params;

  while (nextUrl) {
    const page: {
      items: T[];
      next: string | null;
    } = await spotifyRequest<{
      items: T[];
      next: string | null;
    }>(settings, spotifyCredentials(settings), nextUrl, nextParams);

    items.push(...page.items);
    nextUrl = page.next;
    nextParams = {};
  }

  return items;
}

async function getSpotifyAccessToken(credentials: PrivateSettings["catalog"]["spotify"]) {
  const key = `${credentials.clientId}:${credentials.clientSecret}`;

  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error("Add Spotify client credentials in settings before loading catalog data.");
  }

  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    headers: {
      Authorization: `Basic ${Buffer.from(key, "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Spotify rejected the configured client credentials.");
  }

  const body = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    key
  };

  return cachedToken.accessToken;
}

async function throttleSpotifyRequest(settings: PrivateSettings) {
  const requestsPerMinute = settings.catalog.discovery.requestsPerMinute;
  const now = Date.now();

  if (now - requestWindowStartedAt >= 60_000) {
    requestWindowStartedAt = now;
    requestWindowCount = 0;
  }

  if (requestWindowCount >= requestsPerMinute) {
    const waitMs = Math.max(0, 60_000 - (now - requestWindowStartedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    requestWindowStartedAt = Date.now();
    requestWindowCount = 0;
  }

  requestWindowCount += 1;
}

async function waitForSpotifyRetry(response: Response) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const waitMs = Number.isFinite(retryAfter)
    ? Math.max(1000, Math.min(60_000, retryAfter * 1000))
    : 2000;

  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function spotifyCredentials(
  settings: PrivateSettings,
  override: Partial<PrivateSettings["catalog"]["spotify"]> = {}
) {
  return {
    clientId: override.clientId ?? settings.catalog.spotify.clientId,
    clientSecret: override.clientSecret ?? settings.catalog.spotify.clientSecret,
    market: override.market ?? settings.catalog.spotify.market
  };
}

function spotifyOrganizeTrackIsEligible(track: TrackFile) {
  return spotifyOrganizeHints(track).some(
    (hint) => !isUnknownSpotifyOrganizeValue(hint.title) && !isUnknownSpotifyOrganizeValue(hint.albumArtist || hint.artist)
  );
}

async function findSpotifyOrganizeTrack(settings: PrivateSettings, track: TrackFile) {
  const hints = spotifyOrganizeHints(track);
  const candidates = new Map<string, SpotifyOrganizeTrack>();

  for (const query of spotifyOrganizeQueries(hints)) {
    const response = await spotifyRequest<{ tracks: { items: SpotifyTrack[] } }>(
      settings,
      spotifyCredentials(settings),
      "/v1/search",
      {
        limit: "10",
        market: settings.catalog.spotify.market,
        q: query,
        type: "track"
      }
    );

    for (const candidate of response.tracks.items) {
      const normalized = spotifyOrganizeTrackFromSpotify(candidate);
      if (normalized) {
        candidates.set(normalized.id, normalized);
      }
    }

    if (confidentSpotifyOrganizeScore(Array.from(candidates.values()), hints)) {
      break;
    }
  }

  const scored = spotifyOrganizeScores(Array.from(candidates.values()), hints);
  return confidentSpotifyOrganizeScore(scored);
}

function spotifyOrganizeScores(candidates: SpotifyOrganizeTrack[], hints: SpotifyOrganizeHint[]) {
  return candidates
    .map((candidate) => bestSpotifyOrganizeScore(candidate, hints))
    .filter((score): score is SpotifyOrganizeScore => Boolean(score))
    .sort((left, right) => right.score - left.score || left.track.id.localeCompare(right.track.id));
}

function confidentSpotifyOrganizeScore(
  candidatesOrScores: SpotifyOrganizeTrack[] | SpotifyOrganizeScore[],
  hints?: SpotifyOrganizeHint[]
) {
  const scored = hints
    ? spotifyOrganizeScores(candidatesOrScores as SpotifyOrganizeTrack[], hints)
    : candidatesOrScores as SpotifyOrganizeScore[];
  const [best, second] = scored;

  if (!best) {
    return null;
  }

  const gap = best.score - (second?.score ?? 0);
  const confident =
    (best.exactIsrc && best.score >= 78) ||
    (best.score >= 82 && gap >= 8) ||
    (best.score >= 92 && gap >= 3);

  return confident ? best : null;
}

function spotifyOrganizeHints(track: TrackFile): SpotifyOrganizeHint[] {
  const primary = spotifyOrganizeHintFromTrack(track);
  const pathHint = spotifyOrganizeHintFromPath(track);
  const hints = [primary, pathHint].filter((hint): hint is SpotifyOrganizeHint => Boolean(hint));
  const seen = new Set<string>();

  return hints.filter((hint) => {
    const key = spotifyOrganizeHintKey(hint);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function spotifyOrganizeHintFromTrack(track: TrackFile): SpotifyOrganizeHint {
  return {
    album: cleanSpotifyOrganizeValue(track.album),
    albumArtist: cleanSpotifyOrganizeValue(track.albumArtist),
    artist: cleanSpotifyOrganizeValue(track.artist || track.albumArtist),
    discNumber: track.discNumber,
    duration: track.duration,
    isrc: normalizeIsrc(track.isrc),
    title: cleanSpotifyOrganizeValue(track.title),
    trackNumber: track.trackNumber,
    year: track.year
  };
}

function spotifyOrganizeHintFromPath(track: TrackFile): SpotifyOrganizeHint | null {
  const parsed = path.posix.parse(track.relativePath);
  const folder = parseSpotifyOrganizeAlbumFolder(parsed.dir);
  const filename = parseSpotifyOrganizeFilename(parsed.name, folder);

  if (!filename && !folder) {
    return null;
  }

  return {
    album: cleanSpotifyOrganizeValue(folder?.album || track.album),
    albumArtist: cleanSpotifyOrganizeValue(folder?.artist || track.albumArtist),
    artist: cleanSpotifyOrganizeValue(folder?.artist || track.artist || track.albumArtist),
    discNumber: filename?.discNumber ?? track.discNumber,
    duration: track.duration,
    isrc: normalizeIsrc(track.isrc),
    title: cleanSpotifyOrganizeValue(filename?.title || track.title),
    trackNumber: filename?.trackNumber ?? track.trackNumber,
    year: folder?.year ?? track.year
  };
}

function parseSpotifyOrganizeAlbumFolder(relativeDirectory: string) {
  const segments = relativeDirectory.split("/").filter(Boolean);
  const albumFolderName = segments.at(-1);
  const parentArtistFolderName = segments.at(-2);

  if (!albumFolderName || !parentArtistFolderName) {
    return null;
  }

  const standardMatch = albumFolderName.match(/^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)$/);

  if (standardMatch?.groups && sameSpotifyPathToken(standardMatch.groups.artist, parentArtistFolderName)) {
    return {
      album: standardMatch.groups.album.trim(),
      artist: standardMatch.groups.artist.trim(),
      year: parseSpotifyReleaseYear(standardMatch.groups.year)
    };
  }

  const prefix = `${parentArtistFolderName} - `;
  if (!albumFolderName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }

  const remainder = albumFolderName.slice(prefix.length);
  const remainderMatch = remainder.match(/^(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)$/);

  if (!remainderMatch?.groups) {
    return null;
  }

  return {
    album: remainderMatch.groups.album.trim(),
    artist: parentArtistFolderName.trim(),
    year: parseSpotifyReleaseYear(remainderMatch.groups.year)
  };
}

function parseSpotifyOrganizeFilename(
  value: string,
  folder: ReturnType<typeof parseSpotifyOrganizeAlbumFolder>
) {
  const standardMatch = value.match(
    /^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+\((?<year>\d{4}|Unknown Year)\)\s+-\s+(?:(?<medium>\d{1,2})[-_.](?<mediumTrack>\d{1,3})|(?<track>\d{1,3}))\s+-\s+(?<title>.+)$/
  );

  if (standardMatch?.groups) {
    const artistMatches = !folder || sameSpotifyPathToken(standardMatch.groups.artist, folder.artist);
    const albumMatches = !folder || sameSpotifyPathToken(standardMatch.groups.album, folder.album);
    const year = parseSpotifyReleaseYear(standardMatch.groups.year);
    const yearMatches = !folder?.year || folder.year === year;

    if (artistMatches && albumMatches && yearMatches) {
      return {
        discNumber: parsePositiveInteger(standardMatch.groups.medium) ?? null,
        title: standardMatch.groups.title.trim(),
        trackNumber: parsePositiveInteger(standardMatch.groups.mediumTrack || standardMatch.groups.track) ?? null
      };
    }
  }

  const simpleMatch = value.match(/^(?:(?<medium>\d{1,2})[-_.](?<mediumTrack>\d{1,3})|(?<track>\d{1,3}))\s+-\s+(?<title>.+)$/);

  if (!simpleMatch?.groups) {
    return null;
  }

  return {
    discNumber: parsePositiveInteger(simpleMatch.groups.medium) ?? null,
    title: simpleMatch.groups.title.trim(),
    trackNumber: parsePositiveInteger(simpleMatch.groups.mediumTrack || simpleMatch.groups.track) ?? null
  };
}

function spotifyOrganizeQueries(hints: SpotifyOrganizeHint[]) {
  const queries = new Set<string>();

  for (const hint of hints) {
    if (hint.isrc) {
      queries.add(`isrc:${hint.isrc}`);
    }

    if (hint.title && hint.artist && hint.album) {
      queries.add([
        `track:${spotifySearchField(hint.title)}`,
        `artist:${spotifySearchField(hint.artist)}`,
        `album:${spotifySearchField(hint.album)}`
      ].join(" "));
    }

    if (hint.title && hint.albumArtist && hint.album && hint.albumArtist !== hint.artist) {
      queries.add([
        `track:${spotifySearchField(hint.title)}`,
        `artist:${spotifySearchField(hint.albumArtist)}`,
        `album:${spotifySearchField(hint.album)}`
      ].join(" "));
    }

    if (hint.title && hint.artist) {
      queries.add(`${hint.title} ${hint.artist} ${hint.album}`.trim());
    }
  }

  return Array.from(queries).filter(Boolean).slice(0, 6);
}

function spotifySearchField(value: string) {
  return `"${value.replace(/"/g, " ").replace(/\s+/g, " ").trim()}"`;
}

function spotifyOrganizeTrackFromSpotify(track: SpotifyTrack): SpotifyOrganizeTrack | null {
  const album = track.album;
  const albumArtists = album?.artists?.map((artist) => artist.name).filter(Boolean) ?? [];
  const artists = track.artists?.map((artist) => artist.name).filter(Boolean) ?? albumArtists;

  if (!album || !track.id || !track.name) {
    return null;
  }

  return {
    album: album.name || "Unknown Album",
    albumArtist: albumArtists.join(", ") || artists[0] || "Unknown Artist",
    albumId: album.id,
    albumReleaseDate: album.release_date,
    albumTotalTracks: album.total_tracks ?? null,
    albumType: album.album_type || "",
    artists,
    discNumber: numberOrNull(track.disc_number),
    duration: typeof track.duration_ms === "number" ? Math.round(track.duration_ms / 1000) : null,
    explicit: Boolean(track.explicit),
    id: track.id,
    isrc: normalizeIsrc(track.external_ids?.isrc),
    name: track.name,
    spotifyUrl: track.external_urls?.spotify ?? "",
    trackNumber: numberOrNull(track.track_number)
  };
}

function bestSpotifyOrganizeScore(track: SpotifyOrganizeTrack, hints: SpotifyOrganizeHint[]) {
  return hints
    .map((hint) => scoreSpotifyOrganizeTrack(track, hint))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function scoreSpotifyOrganizeTrack(track: SpotifyOrganizeTrack, hint: SpotifyOrganizeHint): SpotifyOrganizeScore {
  const titleScore = textMatchScore(hint.title, track.name, 35, 24);
  const artistScore = artistMatchScore(hint, track);
  const albumScore = textMatchScore(hint.album, track.album, 20, 12);
  const albumMismatch = !isUnknownSpotifyOrganizeValue(hint.album) && albumScore === 0;
  const exactIsrc = Boolean(hint.isrc && track.isrc && hint.isrc === track.isrc);
  let score = titleScore + artistScore + albumScore;

  if (exactIsrc) {
    score += 70;
  }

  if (durationCloseEnoughSeconds(hint.duration, track.duration, 3)) {
    score += 15;
  } else if (durationCloseEnoughSeconds(hint.duration, track.duration, 8)) {
    score += 8;
  }

  if (hint.trackNumber && track.trackNumber && hint.trackNumber === track.trackNumber) {
    score += 5;
  }

  if (hint.discNumber && track.discNumber && hint.discNumber === track.discNumber) {
    score += 3;
  }

  if (hint.year && parseSpotifyReleaseYear(track.albumReleaseDate) === hint.year) {
    score += 3;
  }

  if (titleScore === 0 || artistScore === 0) {
    score = Math.min(score, exactIsrc ? score : 65);
  }

  if (albumMismatch) {
    score = Math.min(score, 74);
  }

  return {
    exactIsrc,
    hint,
    score,
    track
  };
}

function textMatchScore(left: string, right: string, exactPoints: number, partialPoints: number) {
  const leftKey = normalizeForMatch(left, { removeBracketedText: false });
  const rightKey = normalizeForMatch(right, { removeBracketedText: false });

  if (!leftKey || !rightKey) {
    return 0;
  }

  if (leftKey === rightKey) {
    return exactPoints;
  }

  if (tokenCoverage(leftKey, rightKey) >= 0.85 || tokenCoverage(rightKey, leftKey) >= 0.85) {
    return partialPoints;
  }

  const looseLeftKey = normalizeForMatch(left);
  const looseRightKey = normalizeForMatch(right);

  return looseLeftKey && looseLeftKey === looseRightKey ? partialPoints : 0;
}

function artistMatchScore(hint: SpotifyOrganizeHint, track: SpotifyOrganizeTrack) {
  const hintArtists = splitSpotifyArtists([hint.artist, hint.albumArtist].join("; "));
  const spotifyArtists = splitSpotifyArtists([track.albumArtist, ...track.artists].join("; "));

  for (const left of hintArtists) {
    for (const right of spotifyArtists) {
      if (artistKeysCompatible(left, right)) {
        return 25;
      }
    }
  }

  return 0;
}

function artistKeysCompatible(left: string, right: string) {
  const leftKey = normalizeForMatch(left, { removeBracketedText: false }).replace(/^the\s+/, "");
  const rightKey = normalizeForMatch(right, { removeBracketedText: false }).replace(/^the\s+/, "");

  if (!leftKey || !rightKey) {
    return false;
  }

  return (
    leftKey === rightKey ||
    (leftKey.split(/\s+/).length > 1 && rightKey.split(/\s+/).length > 1 &&
      (tokenCoverage(leftKey, rightKey) === 1 || tokenCoverage(rightKey, leftKey) === 1))
  );
}

function trackFileFromSpotifyOrganizeTrack(track: TrackFile, spotifyTrack: SpotifyOrganizeTrack): TrackFile {
  const artist = spotifyTrack.artists.join("; ") || spotifyTrack.albumArtist;
  const albumArtist = spotifyTrack.albumArtist || artist;
  const year = parseSpotifyReleaseYear(spotifyTrack.albumReleaseDate) ?? track.year;
  const trackNumber = spotifyTrack.trackNumber ?? track.trackNumber;
  const discNumber = spotifyTrack.discNumber ?? track.discNumber;
  const albumType = normalizeSpotifyAlbumType(spotifyTrack.albumType);
  const trackTotal = spotifyTrack.albumTotalTracks ?? track.trackTotal;
  const duration = spotifyTrack.duration ?? track.duration;
  const isrc = spotifyTrack.isrc ?? track.isrc ?? null;
  const issues = track.issues.filter((issue) => {
    if (issue === "Missing artist" && artist) {
      return false;
    }
    if (issue === "Missing album" && spotifyTrack.album) {
      return false;
    }
    if (issue === "Missing track number" && trackNumber) {
      return false;
    }
    return true;
  });

  return {
    ...track,
    artist,
    albumArtist,
    album: spotifyTrack.album,
    albumType,
    title: spotifyTrack.name,
    trackNumber,
    trackTotal,
    discNumber,
    year,
    duration,
    isrc,
    duplicateKey: buildDuplicateKey({
      artist: albumArtist || artist,
      album: spotifyTrack.album,
      albumType: albumType || "Album",
      title: spotifyTrack.name,
      trackNumber,
      discNumber,
      year,
      duration,
      isrc
    }),
    targetSource: "spotify",
    issues
  };
}

function spotifyOrganizeCacheKeys(settings: PrivateSettings, track: TrackFile) {
  const keys = spotifyOrganizeHints(track).map((hint) => sha1(JSON.stringify({
    hint: spotifyOrganizeHintKey(hint),
    market: settings.catalog.spotify.market,
    version: spotifyOrganizeCacheVersion
  })));

  keys.push(spotifyOrganizeLegacyCacheKey(settings, track));

  return Array.from(new Set(keys));
}

function spotifyOrganizeLegacyCacheKey(settings: PrivateSettings, track: TrackFile) {
  return sha1(JSON.stringify({
    market: settings.catalog.spotify.market,
    hints: spotifyOrganizeHints(track).map(spotifyOrganizeHintKey),
    relativePath: track.relativePath,
    version: spotifyOrganizeLegacyCacheVersion
  }));
}

function firstFreshSpotifyOrganizeCacheEntry(
  cache: SpotifyOrganizeCache,
  keys: string[],
  hints: SpotifyOrganizeHint[]
) {
  for (const key of keys) {
    const entry = cache.matches[key];
    if (entry && spotifyOrganizeCacheEntryIsFresh(entry)) {
      if (entry.status === "matched" && (!entry.track || !confidentSpotifyOrganizeScore([entry.track], hints))) {
        continue;
      }
      return entry;
    }
  }

  return null;
}

function spotifyOrganizeHintKey(hint: SpotifyOrganizeHint) {
  return JSON.stringify({
    album: normalizeForMatch(hint.album, { removeBracketedText: false }),
    albumArtist: normalizeForMatch(hint.albumArtist, { removeBracketedText: false }),
    artist: normalizeForMatch(hint.artist, { removeBracketedText: false }),
    discNumber: hint.discNumber,
    duration: hint.duration ? Math.round(hint.duration) : null,
    isrc: hint.isrc,
    title: normalizeForMatch(hint.title, { removeBracketedText: false }),
    trackNumber: hint.trackNumber,
    year: hint.year
  });
}

function spotifyOrganizeCacheEntryIsFresh(entry: SpotifyOrganizeCacheEntry) {
  const matchedAt = Date.parse(entry.matchedAt);

  if (!Number.isFinite(matchedAt)) {
    return false;
  }

  const ttl = entry.status === "matched" ? spotifyOrganizeMatchTtlMs : spotifyOrganizeNoMatchTtlMs;
  return Date.now() - matchedAt <= ttl;
}

async function readSpotifyOrganizeCache(): Promise<SpotifyOrganizeCache> {
  const cache = emptySpotifyOrganizeCache();

  for (const [key, entry] of Object.entries(await readLegacySpotifyOrganizeCacheEntries())) {
    cache.matches[key] = entry;
  }

  try {
    await ensureSpotifyOrganizeDatabaseDirectory();
    const rows = spotifyOrganizeDb()
      .prepare(
        `SELECT lookup_key, matched_at, score, status, track_json
         FROM spotify_organize_matches
         WHERE version = ?`
      )
      .all(spotifyOrganizeCacheVersion) as SpotifyOrganizeCacheRow[];

    for (const row of rows) {
      const entry = spotifyOrganizeCacheEntryFromRow(row);
      if (entry) {
        cache.matches[row.lookup_key] = entry;
      }
    }
  } catch {
    return cache;
  }

  return cache;
}

async function writeSpotifyOrganizeCache(cache: SpotifyOrganizeCache) {
  await ensureSpotifyOrganizeDatabaseDirectory();
  const db = spotifyOrganizeDb();
  const statement = db.prepare(
    `INSERT INTO spotify_organize_matches
      (lookup_key, version, matched_at, score, status, track_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lookup_key) DO UPDATE SET
      version = excluded.version,
      matched_at = excluded.matched_at,
      score = excluded.score,
      status = excluded.status,
      track_json = excluded.track_json`
  );

  db.exec("BEGIN");
  try {
    for (const [lookupKey, entry] of Object.entries(cache.matches)) {
      statement.run(
        lookupKey,
        spotifyOrganizeCacheVersion,
        entry.matchedAt,
        entry.score ?? null,
        entry.status,
        entry.track ? JSON.stringify(entry.track) : null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function emptySpotifyOrganizeCache(): SpotifyOrganizeCache {
  return {
    matches: {},
    updatedAt: new Date(0).toISOString(),
    version: spotifyOrganizeCacheVersion
  };
}

type SpotifyOrganizeCacheRow = {
  lookup_key: string;
  matched_at: string;
  score: number | null;
  status: string;
  track_json: string | null;
};

async function ensureSpotifyOrganizeDatabaseDirectory() {
  await fs.mkdir(path.dirname(spotifyOrganizeDatabasePath), { recursive: true });
}

function spotifyOrganizeDb() {
  if (!spotifyOrganizeDatabase) {
    spotifyOrganizeDatabase = createSpotifyOrganizeDatabase();
    spotifyOrganizeDatabase.exec(`
      CREATE TABLE IF NOT EXISTS spotify_organize_matches (
        lookup_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        matched_at TEXT NOT NULL,
        score REAL,
        status TEXT NOT NULL,
        track_json TEXT
      );
      CREATE INDEX IF NOT EXISTS spotify_organize_matches_version_idx
        ON spotify_organize_matches(version);
    `);
  }

  return spotifyOrganizeDatabase;
}

function createSpotifyOrganizeDatabase(): SqliteDatabase {
  try {
    const nodeSqlite = require("node:sqlite") as { DatabaseSync: new (databasePath: string) => SqliteDatabase };
    return new nodeSqlite.DatabaseSync(spotifyOrganizeDatabasePath);
  } catch {
    const BetterSqlite3 = require("better-sqlite3") as new (databasePath: string) => SqliteDatabase;
    return new BetterSqlite3(spotifyOrganizeDatabasePath);
  }
}

function spotifyOrganizeCacheEntryFromRow(row: SpotifyOrganizeCacheRow): SpotifyOrganizeCacheEntry | null {
  if (row.status !== "matched" && row.status !== "none") {
    return null;
  }

  try {
    return {
      matchedAt: row.matched_at,
      score: row.score ?? undefined,
      status: row.status,
      track: row.track_json ? JSON.parse(row.track_json) as SpotifyOrganizeTrack : undefined
    };
  } catch {
    return null;
  }
}

async function readLegacySpotifyOrganizeCacheEntries() {
  try {
    const raw = await fs.readFile(spotifyOrganizeJsonCachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<{ matches: Record<string, SpotifyOrganizeCacheEntry>; version: number }>;

    if (parsed.version !== spotifyOrganizeLegacyCacheVersion || !parsed.matches) {
      return {};
    }

    return parsed.matches;
  } catch {
    return {};
  }
}

export function closeSpotifyOrganizeStoreForTests() {
  spotifyOrganizeDatabase?.close();
  spotifyOrganizeDatabase = null;
}

function normalizeSpotifyAlbumType(value: string) {
  const albumType = value.trim().toLowerCase();

  if (albumType === "album") {
    return "Album";
  }

  if (albumType === "single") {
    return "Single";
  }

  if (albumType === "compilation") {
    return "Compilation";
  }

  if (albumType === "ep") {
    return "EP";
  }

  return albumType ? titleCaseSpotifyAlbumType(albumType) : "";
}

function titleCaseSpotifyAlbumType(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function splitSpotifyArtists(value: string) {
  return value
    .split(/\s*(?:;|,|\u0000)\s*/)
    .map((artist) => artist.trim())
    .filter(Boolean);
}

function durationCloseEnoughSeconds(left: number | null, right: number | null, tolerance: number) {
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= tolerance;
}

function tokenCoverage(left: string, right: string) {
  const leftTokens = left.split(/\s+/).filter(Boolean);
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));

  if (!leftTokens.length || !rightTokens.size) {
    return 0;
  }

  return leftTokens.filter((token) => rightTokens.has(token)).length / leftTokens.length;
}

function normalizeIsrc(value: unknown) {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() || null : null;
}

function cleanSpotifyOrganizeValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isUnknownSpotifyOrganizeValue(value: string) {
  return ["", "unknown artist", "unknown album", "unknown track"].includes(value.trim().toLowerCase());
}

function sameSpotifyPathToken(left: string, right: string) {
  return pathTokenKey(left) === pathTokenKey(right);
}

function pathTokenKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function parsePositiveInteger(value?: string) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value.split("/")[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSpotifyReleaseYear(value: string | undefined) {
  const match = value?.match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : null;
}

function spotifyArtistSummary(artist: SpotifyArtist): SpotifyArtistSummary {
  return {
    id: artist.id,
    name: artist.name,
    imageUrl: bestImage(artist.images),
    spotifyUrl: artist.external_urls?.spotify ?? ""
  };
}

function spotifyAlbumSummary(album: SpotifyAlbum): SpotifyAlbumSummary {
  return {
    id: album.id,
    name: album.name,
    albumType: album.album_type,
    releaseDate: album.release_date,
    releaseYear: releaseYear(album.release_date),
    totalTracks: album.total_tracks,
    imageUrl: bestImage(album.images),
    spotifyUrl: album.external_urls?.spotify ?? ""
  };
}

function spotifyTrackSummary(
  track: SpotifyTrack,
  localTracks: TrackFile[],
  albumArtist: string,
  album: string
): SpotifyTrackSummary {
  return {
    id: track.id,
    name: track.name,
    artists: track.artists?.map((artist) => artist.name).filter(Boolean) ?? [albumArtist],
    discNumber: track.disc_number,
    trackNumber: track.track_number,
    duration: Math.round(track.duration_ms / 1000),
    explicit: track.explicit,
    spotifyUrl: track.external_urls?.spotify ?? "",
    present: localTrackPresent(localTracks, albumArtist, album, track.name, track.disc_number, track.track_number)
  };
}

function uniqueSpotifyAlbums(albums: SpotifyAlbum[]) {
  const seen = new Set<string>();
  const unique: SpotifyAlbum[] = [];

  for (const album of albums) {
    const key = [
      normalizeForMatch(album.name, { removeBracketedText: false }),
      album.album_type,
      releaseYear(album.release_date) ?? "",
      album.total_tracks
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(album);
    }
  }

  return unique.sort((left, right) =>
    (right.release_date || "").localeCompare(left.release_date || "") ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function localAlbumTrackCount(localTracks: TrackFile[], artist: string, album: string) {
  return localTracks.filter((track) =>
    artistMatches(track, artist) &&
    normalizeForMatch(track.album, { removeBracketedText: false }) ===
      normalizeForMatch(album, { removeBracketedText: false })
  ).length;
}

function localTrackPresent(
  localTracks: TrackFile[],
  artist: string,
  album: string,
  title: string,
  discNumber: number,
  trackNumber: number
) {
  return localTracks.some((track) =>
    artistMatches(track, artist) &&
    normalizeForMatch(track.album, { removeBracketedText: false }) ===
      normalizeForMatch(album, { removeBracketedText: false }) &&
    normalizeForMatch(track.title) === normalizeForMatch(title) &&
    (track.trackNumber === null || track.trackNumber === trackNumber) &&
    (track.discNumber === null || track.discNumber === discNumber)
  );
}

function artistMatches(track: TrackFile, artist: string) {
  const target = normalizeForMatch(artist, { removeBracketedText: false });
  return [track.albumArtist, track.artist]
    .map((value) => normalizeForMatch(value, { removeBracketedText: false }))
    .filter(Boolean)
    .some((value) => value === target || value.includes(target) || target.includes(value));
}

function bestImage(images?: SpotifyImage[]) {
  return images?.slice().sort((left, right) => (right.width ?? 0) - (left.width ?? 0))[0]?.url ?? null;
}

function releaseYear(value: string) {
  const year = Number(value.match(/^\d{4}/)?.[0]);
  return Number.isInteger(year) ? year : null;
}
