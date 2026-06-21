import type { PrivateSettings } from "./settings.js";

export type LidarrNamingConfig = {
  artistFolderFormat: string;
  standardTrackFormat: string;
  multiDiscTrackFormat: string;
  replaceIllegalCharacters: boolean;
  colonReplacementFormat: number;
};

type LidarrNamingResponse = Partial<LidarrNamingConfig> & {
  renameTracks?: boolean;
};

type LidarrRequestOverride = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
};

const defaultLidarrTimeoutMs = 5000;

export async function fetchLidarrNamingConfig(
  settings: PrivateSettings,
  override?: LidarrRequestOverride
) {
  const baseUrl = trimTrailingSlash(override?.baseUrl || settings.naming.lidarr.baseUrl);
  const apiKey = override?.apiKey || settings.naming.lidarr.apiKey;
  const timeoutMs = normalizeTimeoutMs(override?.timeoutMs ?? process.env.NAVICLEAN_LIDARR_TIMEOUT_MS);

  if (!baseUrl || !apiKey) {
    throw new Error("Lidarr URL and API key are required.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetch(new URL("api/v1/config/naming", `${baseUrl}/`), {
      headers: {
        accept: "application/json",
        "X-Api-Key": apiKey
      },
      signal: controller.signal
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Timed out connecting to Lidarr after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Lidarr.`);
  }

  const body = (await response.json()) as LidarrNamingResponse;

  if (!body.artistFolderFormat || !body.standardTrackFormat || !body.multiDiscTrackFormat) {
    throw new Error("Lidarr did not return complete naming formats.");
  }

  return {
    artistFolderFormat: body.artistFolderFormat,
    standardTrackFormat: body.standardTrackFormat,
    multiDiscTrackFormat: body.multiDiscTrackFormat,
    replaceIllegalCharacters: body.replaceIllegalCharacters ?? true,
    colonReplacementFormat: normalizeColonReplacementFormat(body.colonReplacementFormat)
  } satisfies LidarrNamingConfig;
}

export async function testLidarrConnection(
  settings: PrivateSettings,
  override?: LidarrRequestOverride
) {
  try {
    const naming = await fetchLidarrNamingConfig(settings, override);
    return {
      ok: true,
      message: `Loaded Lidarr naming config: ${naming.artistFolderFormat}`
    };
  } catch (error) {
    return {
      ok: false,
      message: (error as Error).message
    };
  }
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeColonReplacementFormat(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 4 ? parsed : 4;
}

function normalizeTimeoutMs(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : defaultLidarrTimeoutMs;
}
