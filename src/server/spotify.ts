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

  const response = await spotifyRequest<{ tracks: { items: SpotifyTrack[] } }>(
    settings,
    spotifyCredentials(settings),
    "/v1/search",
    {
      limit: "12",
      market: settings.catalog.spotify.market,
      q: search,
      type: "track"
    }
  );

  const matches = response.tracks.items.filter((track) => Boolean(track?.album)).map(spotifyMetadataMatch);

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

  const track = await spotifyRequest<SpotifyTrack>(
    settings,
    spotifyCredentials(settings),
    `/v1/tracks/${encodeURIComponent(id)}`,
    { market: settings.catalog.spotify.market }
  );

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
  const detailedTracks = options.hydrateTrackDetails === false
    ? albumTracks
    : await fetchSpotifyTrackDetails(settings, albumTracks);
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
  const hydrated = new Map<string, SpotifyTrack>();
  const ids = tracks.map((track) => track.id).filter(Boolean);

  for (const batch of chunks(ids, 50)) {
    const response = await spotifyRequest<{ tracks: SpotifyTrack[] }>(
      settings,
      spotifyCredentials(settings),
      "/v1/tracks",
      {
        ids: batch.join(","),
        market: settings.catalog.spotify.market
      }
    );

    for (const track of response.tracks) {
      if (track?.id) {
        hydrated.set(track.id, track);
      }
    }
  }

  return tracks.map((track) => ({
    ...track,
    ...hydrated.get(track.id)
  }));
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
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
