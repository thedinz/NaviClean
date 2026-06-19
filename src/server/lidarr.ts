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

export async function fetchLidarrNamingConfig(
  settings: PrivateSettings,
  override?: { baseUrl?: string; apiKey?: string }
) {
  const baseUrl = trimTrailingSlash(override?.baseUrl || settings.naming.lidarr.baseUrl);
  const apiKey = override?.apiKey || settings.naming.lidarr.apiKey;

  if (!baseUrl || !apiKey) {
    throw new Error("Lidarr URL and API key are required.");
  }

  const response = await fetch(new URL("api/v1/config/naming", `${baseUrl}/`), {
    headers: {
      accept: "application/json",
      "X-Api-Key": apiKey
    }
  });

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
  override?: { baseUrl?: string; apiKey?: string }
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
