import type {
  SpotifyAlbumDetail,
  SpotifyAlbumSummary,
  SpotifyArtistDiscography,
  SpotifyArtistSummary,
  SpotifyCatalogDownloadPlan,
  SpotifyCatalogMatch,
  SpotifyMetadataMatch,
  SpotifyMetadataSearchResult,
  SpotifyTestResult,
  SpotifyTrackSummary,
  TrackFile
} from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { normalizeForMatch } from "./utils.js";

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

type SpotifyPage<T> = {
  items: T[];
  next?: string | null;
};

type SpotifyToken = {
  accessToken: string;
  expiresAt: number;
  key: string;
};

let cachedToken: SpotifyToken | null = null;
let requestWindowStartedAt = 0;
let requestWindowCount = 0;
const spotifyMetadataMatchCache = new Map<string, { expiresAt: number; match: SpotifyMetadataMatch }>();
const spotifyMetadataMatchCacheTtlMs = 10 * 60 * 1000;
const spotifyTrackDetailCache = new Map<string, { expiresAt: number; track: SpotifyTrack }>();
const spotifyTrackDetailCacheTtlMs = 60 * 60 * 1000;
const spotifyTrackDetailConcurrency = 4;
const spotifySearchPageLimit = 10;
const spotifyTrackSearchResultLimit = 12;
const spotifyRequestAttempts = 4;

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

export async function searchSpotifyTrackMetadata(
  settings: PrivateSettings,
  query: string
): Promise<SpotifyMetadataSearchResult> {
  const search = query.trim();

  if (!search) {
    return { query: "", matches: [] };
  }

  const tracks = await searchSpotifyTracks(settings, search, spotifyTrackSearchResultLimit);
  const matches = tracks.filter((track) => Boolean(track?.album)).map(spotifyMetadataMatch);

  for (const match of matches) {
    spotifyMetadataMatchCache.set(match.id, {
      expiresAt: Date.now() + spotifyMetadataMatchCacheTtlMs,
      match
    });
  }

  return {
    query: search,
    matches
  };
}

export async function getSpotifyTrackMetadata(
  settings: PrivateSettings,
  trackId: string
): Promise<SpotifyMetadataMatch> {
  const id = trackId.trim();

  if (!id) {
    throw new Error("Spotify track id is required.");
  }

  const cached = spotifyMetadataMatchCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.match;
  }

  spotifyMetadataMatchCache.delete(id);

  const track = await getSpotifyTrackDetail(settings, id);

  if (!track.album) {
    throw new Error("Spotify did not return album metadata for this track.");
  }

  return spotifyMetadataMatch(track);
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
  albumId: string,
  options: { hydrateTrackDetails?: boolean } = {}
): Promise<SpotifyAlbumDetail> {
  const album = await spotifyRequest<SpotifyAlbum & { tracks: SpotifyPage<SpotifyTrack> }>(
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
  const remainingTracks = album.tracks.next
    ? await getAllSpotifyPages<SpotifyTrack>(settings, album.tracks.next, {})
    : [];
  const albumTracks = [...album.tracks.items, ...remainingTracks];
  const detailedTracks = options.hydrateTrackDetails === true
    ? await fetchSpotifyTrackDetails(settings, albumTracks)
    : albumTracks;
  const tracks = detailedTracks.map((track) =>
    spotifyTrackSummary(track, localTracks, albumArtist, albumName)
  );

  return {
    ...spotifyAlbumSummary(album),
    artist: spotifyArtistSummary(artist),
    tracks,
    localTrackCount: tracks.filter((track) => track.present).length
  };
}

async function fetchSpotifyTrackDetails(settings: PrivateSettings, tracks: SpotifyTrack[]) {
  const ids = tracks.map((track) => track.id).filter(Boolean);
  const details = await mapWithConcurrency(
    ids,
    spotifyTrackDetailConcurrency,
    (id) => getSpotifyTrackDetail(settings, id)
  );
  const hydrated = new Map(details.map((track) => [track.id, track]));

  return tracks.map((track) => ({
    ...track,
    ...hydrated.get(track.id)
  }));
}

async function searchSpotifyTracks(
  settings: PrivateSettings,
  query: string,
  resultLimit: number
) {
  const tracks: SpotifyTrack[] = [];
  let offset = 0;

  while (tracks.length < resultLimit) {
    const limit = Math.min(spotifySearchPageLimit, resultLimit - tracks.length);
    const response = await spotifyRequest<{ tracks: { items: SpotifyTrack[] } }>(
      settings,
      spotifyCredentials(settings),
      "/v1/search",
      {
        limit: String(limit),
        market: settings.catalog.spotify.market,
        offset: String(offset),
        q: query,
        type: "track"
      }
    );
    const items = response.tracks.items ?? [];

    tracks.push(...items);
    if (items.length < limit) {
      break;
    }
    offset += items.length;
  }

  return tracks;
}

async function getSpotifyTrackDetail(settings: PrivateSettings, trackId: string) {
  const cacheKey = [
    settings.catalog.spotify.clientId,
    settings.catalog.spotify.market,
    trackId
  ].join(":");
  const cached = spotifyTrackDetailCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.track;
  }

  spotifyTrackDetailCache.delete(cacheKey);
  const track = await spotifyRequest<SpotifyTrack>(
    settings,
    spotifyCredentials(settings),
    `/v1/tracks/${encodeURIComponent(trackId)}`,
    { market: settings.catalog.spotify.market }
  );

  spotifyTrackDetailCache.set(cacheKey, {
    expiresAt: Date.now() + spotifyTrackDetailCacheTtlMs,
    track
  });
  return track;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(items[index]);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export async function buildSpotifyDownloadPlan(
  settings: PrivateSettings,
  localTracks: TrackFile[],
  albumId: string,
  trackIds?: string[]
): Promise<SpotifyCatalogDownloadPlan> {
  const album = await getSpotifyAlbumDetail(settings, localTracks, albumId, {
    hydrateTrackDetails: false
  });
  const selectedIds = new Set(trackIds?.filter(Boolean) ?? []);
  const selectedTrackSummaries = selectedIds.size
    ? album.tracks.filter((track) => selectedIds.has(track.id))
    : album.tracks.filter((track) => !track.present);
  const selectedTracks = await hydrateSpotifyTrackSummaries(settings, selectedTrackSummaries);
  const selectedTracksById = new Map(selectedTracks.map((track) => [track.id, track]));
  const hydratedAlbum = {
    ...album,
    tracks: album.tracks.map((track) => selectedTracksById.get(track.id) ?? track)
  };

  return {
    album: hydratedAlbum,
    selectedTracks,
    supportedProviders: ["youtube", "jiosaavn"],
    warnings: [
      "Spotify is used for metadata only. Provider downloads must be limited to content you are authorized to download."
    ]
  };
}

async function hydrateSpotifyTrackSummaries(
  settings: PrivateSettings,
  tracks: SpotifyTrackSummary[]
) {
  const details = await mapWithConcurrency(
    tracks,
    spotifyTrackDetailConcurrency,
    (track) => getSpotifyTrackDetail(settings, track.id)
  );

  return tracks.map((track, index) => {
    const detail = details[index];
    const artists = detail.artists?.map((artist) => artist.name).filter(Boolean) ?? [];

    return {
      ...track,
      name: detail.name,
      artists: artists.length > 0 ? artists : track.artists,
      discNumber: detail.disc_number,
      trackNumber: detail.track_number,
      duration: Math.round(detail.duration_ms / 1000),
      explicit: detail.explicit,
      isrc: normalizeSpotifyIsrc(detail.external_ids?.isrc) ?? track.isrc,
      spotifyUrl: detail.external_urls?.spotify ?? track.spotifyUrl
    };
  });
}

async function spotifyRequest<T>(
  settings: PrivateSettings,
  credentials: PrivateSettings["catalog"]["spotify"],
  endpoint: string,
  params: Record<string, string> = {}
): Promise<T> {
  for (let attempt = 0; attempt < spotifyRequestAttempts; attempt += 1) {
    await throttleSpotifyRequest(settings);
    const token = await getSpotifyAccessToken(credentials);
    const url = new URL(endpoint, "https://api.spotify.com");

    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    let response: Response;

    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
    } catch (error) {
      if (attempt < spotifyRequestAttempts - 1) {
        await waitForSpotifyRetry(null, attempt);
        continue;
      }

      const message = error instanceof Error && error.message
        ? `: ${error.message}`
        : "";
      throw new Error(`Spotify catalog request failed after ${spotifyRequestAttempts} attempts${message}`);
    }

    if (isRetryableSpotifyStatus(response.status) && attempt < spotifyRequestAttempts - 1) {
      await waitForSpotifyRetry(response, attempt);
      continue;
    }

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(
          `Spotify catalog is temporarily unavailable (HTTP ${response.status}). Try again shortly.`
        );
      }
      throw new Error(`Spotify catalog returned HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  throw new Error("Spotify catalog request did not succeed.");
}

function isRetryableSpotifyStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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
    const page: SpotifyPage<T> = await spotifyRequest<SpotifyPage<T>>(
      settings,
      spotifyCredentials(settings),
      nextUrl,
      nextParams
    );

    items.push(...page.items);
    nextUrl = page.next ?? null;
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

async function waitForSpotifyRetry(response: Response | null, attempt: number) {
  const retryAfterHeader = response?.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
    ? Number.NaN
    : Number(retryAfterHeader);
  const waitMs = Number.isFinite(retryAfter)
    ? Math.max(0, Math.min(60_000, retryAfter * 1000))
    : response?.status === 429
      ? 2000
      : Math.min(4000, 500 * (2 ** attempt));

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
    isrc: normalizeSpotifyIsrc(track.external_ids?.isrc),
    spotifyUrl: track.external_urls?.spotify ?? "",
    present: localTrackPresent(localTracks, albumArtist, album, track.name, track.disc_number, track.track_number)
  };
}

function spotifyMetadataMatch(track: SpotifyTrack): SpotifyMetadataMatch {
  const album = track.album as SpotifyAlbum;
  const albumArtist = album.artists[0]?.name || track.artists?.[0]?.name || "Unknown Artist";
  const artists = track.artists?.map((artist) => artist.name).filter(Boolean) ?? [];

  return {
    id: track.id,
    name: track.name,
    artists: artists.length > 0 ? artists : [albumArtist],
    albumArtist,
    albumId: album.id,
    album: album.name,
    albumType: album.album_type,
    releaseDate: album.release_date,
    releaseYear: releaseYear(album.release_date),
    imageUrl: bestImage(album.images),
    discNumber: track.disc_number,
    trackNumber: track.track_number,
    duration: Math.round(track.duration_ms / 1000),
    isrc: normalizeSpotifyIsrc(track.external_ids?.isrc),
    spotifyUrl: track.external_urls?.spotify ?? ""
  };
}

function normalizeSpotifyIsrc(value: unknown) {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() || null : null;
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
