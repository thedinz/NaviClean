import crypto from "node:crypto";
import type { PrivateSettings } from "./settings.js";
import { normalizeForMatch } from "./utils.js";

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
  params: Record<string, string>
): Promise<T | null> {
  const response = await fetch(subsonicUrl(settings.navidrome, endpoint, { ...params, f: "json" }), {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as SubsonicResponse<T>;
  const subsonic = body["subsonic-response"];

  if (subsonic?.status !== "ok") {
    return null;
  }

  return subsonic;
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

function asArray<T>(value: T[] | T | undefined) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalized(value: unknown) {
  return normalizeForMatch(typeof value === "string" ? value : "", { removeBracketedText: false });
}
