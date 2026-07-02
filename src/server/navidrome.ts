import crypto from "node:crypto";
import path from "node:path";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, normalizeForMatch, toPosixRelative } from "./utils.js";

type SubsonicResponse<T> = {
  "subsonic-response"?: T & {
    status?: string;
    version?: string;
    error?: {
      message?: string;
    };
  };
};

type SearchResult3 = {
  searchResult3?: {
    artist?: NavidromeArtist[];
    album?: NavidromeAlbum[];
  };
};

type AlbumList2 = {
  albumList2?: {
    album?: NavidromeAlbum[];
  };
};

type NavidromeArtist = {
  id?: string;
  name?: string;
  coverArt?: string;
};

type NavidromeArtistDetail = {
  artist?: NavidromeArtist & {
    album?: NavidromeAlbum[];
  };
};

type NavidromeAlbum = {
  id?: string;
  name?: string;
  title?: string;
  artist?: string;
  coverArt?: string;
  year?: number;
  song?: NavidromeSong[];
  songCount?: number;
};

type NavidromeAlbumDetail = {
  album?: NavidromeAlbum;
};

type NavidromeSong = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: number | string;
  discNumber?: number | string;
  year?: number | string;
  duration?: number | string;
  bitRate?: number | string;
  size?: number | string;
  suffix?: string;
  path?: string;
  isrc?: string;
};

export type NavidromeLibraryTrackPathStatus = "usable" | "missing" | "outside-library-root";

export type NavidromeLibraryTrack = {
  id: string;
  sourceAbsolutePath: string | null;
  sourceRelativePath: string | null;
  sourceRawPath: string | null;
  sourcePathStatus: NavidromeLibraryTrackPathStatus;
  artist: string;
  albumArtist: string;
  album: string;
  albumType: string;
  title: string;
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  size: number | null;
  suffix: string;
  isrc: string | null;
};

export type NavidromeArtworkLookup =
  | {
      type: "artist";
      artist: string;
    }
  | {
      type: "album";
      artist: string;
      album: string;
      year?: string;
    };

export type NavidromeArtwork = {
  contentType: string;
  data: Buffer;
};

export async function testNavidromeConnection(
  settings: PrivateSettings,
  override?: { baseUrl?: string; username?: string; password?: string }
) {
  const baseUrl = (override?.baseUrl || settings.navidrome.baseUrl).replace(/\/+$/, "");
  const username = override?.username || settings.navidrome.username;
  const password = override?.password || settings.navidrome.password;

  if (!baseUrl || !username || !password) {
    return {
      ok: false,
      message: "Navidrome URL, username, and password are required"
    };
  }

  const url = subsonicUrl({ baseUrl, username, password }, "rest/ping.view", { f: "json" });

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${response.status} from Navidrome`
    };
  }

  const body = (await response.json()) as SubsonicResponse<Record<string, never>>;
  const subsonic = body["subsonic-response"];

  if (subsonic?.status === "ok") {
    return {
      ok: true,
      message: `Connected to Subsonic API ${subsonic.version || "1.16.1"}`
    };
  }

  return {
    ok: false,
    message: subsonic?.error?.message || "Navidrome rejected the connection"
  };
}

export async function fetchNavidromeArtwork(
  settings: PrivateSettings,
  lookup: NavidromeArtworkLookup,
  size: number
): Promise<NavidromeArtwork | null> {
  if (!settings.navidrome.baseUrl || !settings.navidrome.username || !settings.navidrome.password) {
    return null;
  }

  const coverArtId = lookup.type === "album"
    ? await resolveAlbumCoverArtId(settings, lookup)
    : await resolveArtistCoverArtId(settings, lookup.artist);

  if (!coverArtId) {
    return null;
  }

  const response = await fetch(
    subsonicUrl(settings.navidrome, "rest/getCoverArt.view", {
      id: coverArtId,
      size: String(size)
    }),
    {
      headers: {
        accept: "image/*"
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";

  if (!contentType.toLowerCase().startsWith("image/")) {
    return null;
  }

  return {
    contentType,
    data: Buffer.from(await response.arrayBuffer())
  };
}

export async function fetchNavidromeLibraryTracks(settings: PrivateSettings): Promise<NavidromeLibraryTrack[]> {
  if (!settings.navidrome.baseUrl || !settings.navidrome.username || !settings.navidrome.password) {
    return [];
  }

  const albums = await fetchNavidromeAlbums(settings);
  const tracks: NavidromeLibraryTrack[] = [];

  for (const albumBatch of chunks(albums, 8)) {
    const details = await Promise.all(albumBatch.map((album) => fetchNavidromeAlbum(settings, album.id)));

    for (const detail of details) {
      const album = detail?.album;

      if (!album) {
        continue;
      }

      for (const song of asArray(album.song)) {
        tracks.push(navidromeLibraryTrackFromSong(settings, album, song));
      }
    }
  }

  return tracks;
}

async function fetchNavidromeAlbums(settings: PrivateSettings) {
  const albums: NavidromeAlbum[] = [];
  const pageSize = 500;

  for (let offset = 0; offset < 100_000; offset += pageSize) {
    const body = await subsonicJson<AlbumList2>(settings, "rest/getAlbumList2.view", {
      type: "alphabeticalByName",
      size: String(pageSize),
      offset: String(offset)
    }, {
      throwOnError: true
    });
    const page = asArray(body?.albumList2?.album);

    albums.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return albums;
}

async function fetchNavidromeAlbum(settings: PrivateSettings, albumId: string | undefined) {
  if (!albumId) {
    return null;
  }

  return subsonicJson<NavidromeAlbumDetail>(settings, "rest/getAlbum.view", {
    id: albumId
  }, {
    throwOnError: true
  });
}

function navidromeLibraryTrackFromSong(
  settings: PrivateSettings,
  album: NavidromeAlbum,
  song: NavidromeSong
): NavidromeLibraryTrack {
  const source = navidromeSongSourcePath(settings, song.path);
  const albumTitle = stringValue(song.album) || stringValue(album.name) || stringValue(album.title);
  const albumArtist = stringValue(song.albumArtist) || stringValue(album.artist) || stringValue(song.artist);
  const artist = stringValue(song.artist) || albumArtist;

  return {
    id: stringValue(song.id) || crypto.createHash("sha1").update(JSON.stringify(song)).digest("hex"),
    sourceAbsolutePath: source?.absolutePath ?? null,
    sourceRelativePath: source?.relativePath ?? null,
    sourceRawPath: source.rawPath,
    sourcePathStatus: source.status,
    artist,
    albumArtist: albumArtist || artist,
    album: albumTitle,
    albumType: "Album",
    title: stringValue(song.title),
    trackNumber: positiveInteger(song.track),
    trackTotal: positiveInteger(album.songCount),
    discNumber: positiveInteger(song.discNumber),
    discTotal: null,
    year: positiveInteger(song.year) ?? positiveInteger(album.year),
    duration: positiveInteger(song.duration),
    bitrate: kilobitsToBits(positiveInteger(song.bitRate)),
    size: positiveInteger(song.size),
    suffix: stringValue(song.suffix),
    isrc: stringValue(song.isrc) || null
  };
}

function navidromeSongSourcePath(settings: PrivateSettings, songPath: unknown) {
  const value = stringValue(songPath);

  if (!value) {
    return {
      absolutePath: null,
      relativePath: null,
      rawPath: null,
      status: "missing" as const
    };
  }

  const root = path.resolve(settings.naming.libraryPath);
  const absolutePath = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, ...value.split(/[\\/]+/).filter(Boolean));

  if (!isInsidePath(root, absolutePath)) {
    return {
      absolutePath: null,
      relativePath: null,
      rawPath: value,
      status: "outside-library-root" as const
    };
  }

  return {
    absolutePath,
    relativePath: toPosixRelative(root, absolutePath),
    rawPath: value,
    status: "usable" as const
  };
}

async function resolveArtistCoverArtId(settings: PrivateSettings, artistName: string) {
  const artists = await searchNavidromeArtists(settings, artistName);
  const artist = bestArtistMatch(artists, artistName);

  if (artist?.coverArt) {
    return artist.coverArt;
  }

  if (artist?.id) {
    const detail = await subsonicJson<NavidromeArtistDetail>(settings, "rest/getArtist.view", {
      id: artist.id
    });
    const detailArtist = detail?.artist;
    const albumCoverArt = firstCoverArt(detailArtist?.album || []);

    if (detailArtist?.coverArt) {
      return detailArtist.coverArt;
    }

    if (albumCoverArt) {
      return albumCoverArt;
    }
  }

  const albums = await searchNavidromeAlbums(settings, artistName);
  const album = albums.find((candidate) => normalized(candidate.artist) === normalized(artistName)) || albums[0];
  return album?.coverArt || album?.id || null;
}

async function resolveAlbumCoverArtId(
  settings: PrivateSettings,
  lookup: Extract<NavidromeArtworkLookup, { type: "album" }>
) {
  const albums = await searchNavidromeAlbums(settings, `${lookup.artist} ${lookup.album}`);
  const album = bestAlbumMatch(albums, lookup.artist, lookup.album, lookup.year);
  return album?.coverArt || album?.id || null;
}

async function searchNavidromeArtists(settings: PrivateSettings, query: string) {
  const body = await subsonicJson<SearchResult3>(settings, "rest/search3.view", {
    query,
    artistCount: "10",
    albumCount: "0",
    songCount: "0"
  });

  return asArray(body?.searchResult3?.artist);
}

async function searchNavidromeAlbums(settings: PrivateSettings, query: string) {
  const body = await subsonicJson<SearchResult3>(settings, "rest/search3.view", {
    query,
    artistCount: "0",
    albumCount: "20",
    songCount: "0"
  });

  return asArray(body?.searchResult3?.album);
}

async function subsonicJson<T extends object>(
  settings: PrivateSettings,
  endpoint: string,
  params: Record<string, string>,
  options: { throwOnError?: boolean } = {}
): Promise<T | null> {
  let response: Response;

  try {
    response = await fetch(subsonicUrl(settings.navidrome, endpoint, { ...params, f: "json" }), {
      headers: {
        accept: "application/json"
      }
    });
  } catch (error) {
    return subsonicFailure(`Navidrome API request failed: ${(error as Error).message}`, options);
  }

  if (!response.ok) {
    return subsonicFailure(`Navidrome API request failed: HTTP ${response.status}`, options);
  }

  let body: SubsonicResponse<T>;

  try {
    body = (await response.json()) as SubsonicResponse<T>;
  } catch (error) {
    return subsonicFailure(`Navidrome API request failed: invalid JSON (${(error as Error).message})`, options);
  }

  const subsonic = body["subsonic-response"];

  if (subsonic?.status !== "ok") {
    return subsonicFailure(
      `Navidrome API request failed: ${subsonic?.error?.message || "Subsonic response was not ok"}`,
      options
    );
  }

  return subsonic;
}

function subsonicFailure<T>(message: string, options: { throwOnError?: boolean }): T | null {
  if (options.throwOnError) {
    throw new Error(message);
  }

  return null;
}

function subsonicUrl(
  credentials: Pick<PrivateSettings["navidrome"], "baseUrl" | "username" | "password">,
  endpoint: string,
  params: Record<string, string>
) {
  const salt = crypto.randomBytes(8).toString("hex");
  const token = crypto.createHash("md5").update(`${credentials.password}${salt}`).digest("hex");
  const url = new URL(endpoint, `${credentials.baseUrl.replace(/\/+$/, "")}/`);

  url.searchParams.set("u", credentials.username);
  url.searchParams.set("t", token);
  url.searchParams.set("s", salt);
  url.searchParams.set("v", "1.16.1");
  url.searchParams.set("c", "NaviClean");

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

function bestArtistMatch(artists: NavidromeArtist[], artistName: string) {
  const wantedArtist = normalized(artistName);
  return artists.find((artist) => normalized(artist.name) === wantedArtist) || artists[0] || null;
}

function bestAlbumMatch(albums: NavidromeAlbum[], artistName: string, albumTitle: string, year?: string) {
  const wantedArtist = normalized(artistName);
  const wantedAlbum = normalized(albumTitle);
  const wantedYear = year && /^\d{4}$/.test(year) ? Number(year) : null;
  const exact = albums.find((album) => {
    if (normalized(album.name || album.title) !== wantedAlbum) {
      return false;
    }

    if (wantedArtist && normalized(album.artist) !== wantedArtist) {
      return false;
    }

    return !wantedYear || !album.year || album.year === wantedYear;
  });

  if (exact) {
    return exact;
  }

  return albums.find((album) => normalized(album.name || album.title) === wantedAlbum) || albums[0] || null;
}

function firstCoverArt(albums: NavidromeAlbum[]) {
  const album = albums.find((candidate) => candidate.coverArt || candidate.id);
  return album?.coverArt || album?.id || null;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function asArray<T>(value: T[] | T | undefined) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalized(value: unknown) {
  return normalizeForMatch(typeof value === "string" ? value : "", { removeBracketedText: false });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

function kilobitsToBits(value: number | null) {
  return value ? value * 1000 : null;
}
