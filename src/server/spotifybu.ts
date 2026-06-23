import path from "node:path";
import type { TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";

export type SpotifyBuTarget = {
  album?: string;
  albumArtist?: string;
  playlistIds?: string[];
  playlistNames?: string[];
  sourceRelativePath: string;
  spotifyTrackIds?: string[];
  spotifyTrackNames?: string[];
  targetRelativePath: string;
};

type SpotifyBuTargetsResponse = {
  conflicts?: Array<{
    sourceRelativePath: string;
    targets: Array<{
      targetRelativePath: string;
    }>;
  }>;
  targets?: SpotifyBuTarget[];
  warnings?: string[];
};

export async function fetchSpotifyBuTargets(settings: PrivateSettings, tracks: TrackFile[]) {
  const targets = new Map<string, SpotifyBuTarget>();

  if (settings.naming.mode !== "spotifybu") {
    return targets;
  }

  if (!settings.spotifybu.baseUrl) {
    throw new Error("SpotifyBU naming mode requires a SpotifyBU URL in settings.");
  }

  const response = await fetch(`${settings.spotifybu.baseUrl}/api/naviclean/targets`, {
    method: "POST",
    headers: spotifyBuHeaders(settings),
    body: JSON.stringify({
      tracks: tracks.map((track) => ({
        duration: track.duration,
        relativePath: track.relativePath,
        size: track.size
      }))
    })
  });

  if (!response.ok) {
    throw new Error(`SpotifyBU target lookup failed: ${await spotifyBuErrorMessage(response)}`);
  }

  const body = (await response.json()) as SpotifyBuTargetsResponse;

  if (body.conflicts?.length) {
    throw new Error(
      `SpotifyBU returned conflicting targets for ${body.conflicts.length} file${body.conflicts.length === 1 ? "" : "s"}.`
    );
  }

  for (const target of body.targets ?? []) {
    const cleanTargetPath = normalizeSpotifyBuRelativePath(target.targetRelativePath);

    if (!cleanTargetPath) {
      continue;
    }

    targets.set(normalizedRelativePathKey(target.sourceRelativePath), {
      ...target,
      targetRelativePath: cleanTargetPath
    });
  }

  return targets;
}

export async function testSpotifyBuConnection(
  settings: PrivateSettings,
  override: Partial<PrivateSettings["spotifybu"]> = {}
) {
  const credentials = {
    baseUrl: trimTrailingSlash(override.baseUrl || settings.spotifybu.baseUrl),
    username: override.username || settings.spotifybu.username,
    password: override.password || settings.spotifybu.password
  };

  if (!credentials.baseUrl) {
    return {
      ok: false,
      message: "SpotifyBU URL is required"
    };
  }

  const response = await fetch(`${credentials.baseUrl}/api/naviclean/targets`, {
    method: "POST",
    headers: spotifyBuHeaders({ ...settings, spotifybu: credentials }),
    body: JSON.stringify({ tracks: [] })
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `SpotifyBU rejected the connection: ${await spotifyBuErrorMessage(response)}`
    };
  }

  return {
    ok: true,
    message: "Connected to SpotifyBU"
  };
}

export function spotifyBuTargetForTrack(targets: Map<string, SpotifyBuTarget>, track: TrackFile) {
  return targets.get(normalizedRelativePathKey(track.relativePath));
}

function spotifyBuHeaders(settings: Pick<PrivateSettings, "spotifybu">) {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (settings.spotifybu.username || settings.spotifybu.password) {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${settings.spotifybu.username}:${settings.spotifybu.password}`, "utf8").toString("base64")}`
    );
  }

  return headers;
}

async function spotifyBuErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function normalizeSpotifyBuRelativePath(value: string) {
  const normalized = value.split(/[\\/]+/).filter(Boolean).join("/");

  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return "";
  }

  return normalized;
}

function normalizedRelativePathKey(value: string) {
  return value.split(/[\\/]+/).join("/").toLowerCase();
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
