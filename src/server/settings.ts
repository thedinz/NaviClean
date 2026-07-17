import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NamingMode, SettingsUpdate, SettingsView } from "../shared/types.js";

export type PrivateSettings = {
  auth: {
    enabled: boolean;
    username: string;
    passwordHash: string;
  };
  navidrome: {
    baseUrl: string;
    username: string;
    password: string;
  };
  catalog: {
    spotify: {
      clientId: string;
      clientSecret: string;
      market: string;
    };
    providers: {
      maxConcurrentDownloads: number;
      opusQuality: 160 | 192 | 256;
      mp3FallbackEnabled: boolean;
      mp3FallbackQuality: 192 | 256 | 320;
    };
    discovery: {
      requestsPerMinute: number;
    };
  };
  naming: {
    mode: NamingMode;
    libraryPath: string;
    recycleBinPath: string;
    artistFolderFormat: string;
    standardTrackFormat: string;
    multiDiscTrackFormat: string;
    replaceIllegalCharacters: boolean;
    colonReplacementFormat: number;
  };
  scan: {
    extensions: string[];
    autoScanEnabled: boolean;
    autoScanTime: string;
  };
  cleanup: {
    emptyFolderExclusions: string[];
  };
};

const defaultExtensions = [
  ".flac",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wav",
  ".aiff",
  ".aif",
  ".alac",
  ".wma"
];
const defaultScan = {
  extensions: defaultExtensions,
  autoScanEnabled: true,
  autoScanTime: "02:00"
};
const defaultCleanup = {
  // Keep the pre-rebrand .spotifybu path excluded so existing TrackKeep installs remain safe.
  emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
};
export const standardNamingFormatDefaults = {
  artistFolderFormat: "{Album Artist Name}",
  standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
  multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
  replaceIllegalCharacters: true,
  colonReplacementFormat: 4
} as const;
const defaultNaming = {
  mode: "standard" as const,
  libraryPath: process.env.NAVICLEAN_MUSIC_DIR || "/music",
  recycleBinPath: path.join(process.env.NAVICLEAN_MUSIC_DIR || "/music", ".naviclean-trash"),
  ...standardNamingFormatDefaults
};
const defaultCatalog = {
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    market: process.env.SPOTIFY_MARKET || "US"
  },
  providers: {
    maxConcurrentDownloads: 1,
    opusQuality: 192 as const,
    mp3FallbackEnabled: true,
    mp3FallbackQuality: 320 as const
  },
  discovery: {
    requestsPerMinute: 40
  }
};

const dataDir = process.env.NAVICLEAN_DATA_DIR || path.resolve(process.cwd(), ".data");
const settingsPath = path.join(dataDir, "settings.json");
let fallbackPasswordHash: string | null = null;

export function getDataDir() {
  return dataDir;
}

export async function loadSettings(): Promise<PrivateSettings> {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<PrivateSettings>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const settings = await createDefaultSettings();
    await saveSettings(settings);
    return settings;
  }
}

export async function saveSettings(settings: PrivateSettings) {
  await fs.mkdir(dataDir, { recursive: true });
  const tempPath = `${settingsPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, settingsPath);
}

export function toSettingsView(settings: PrivateSettings): SettingsView {
  return {
    auth: {
      enabled: settings.auth.enabled,
      username: settings.auth.username
    },
    navidrome: {
      baseUrl: settings.navidrome.baseUrl,
      username: settings.navidrome.username,
      passwordSet: settings.navidrome.password.length > 0
    },
    catalog: {
      spotify: {
        clientId: settings.catalog.spotify.clientId,
        clientSecretSet: settings.catalog.spotify.clientSecret.length > 0,
        market: settings.catalog.spotify.market
      },
      providers: settings.catalog.providers,
      discovery: settings.catalog.discovery
    },
    naming: {
      mode: settings.naming.mode,
      libraryPath: settings.naming.libraryPath,
      recycleBinPath: settings.naming.recycleBinPath,
      artistFolderFormat: settings.naming.artistFolderFormat,
      standardTrackFormat: settings.naming.standardTrackFormat,
      multiDiscTrackFormat: settings.naming.multiDiscTrackFormat,
      replaceIllegalCharacters: settings.naming.replaceIllegalCharacters,
      colonReplacementFormat: settings.naming.colonReplacementFormat
    },
    scan: settings.scan,
    cleanup: settings.cleanup
  };
}

export async function updateSettings(update: SettingsUpdate): Promise<PrivateSettings> {
  const current = await loadSettings();
  const next: PrivateSettings = {
    auth: { ...current.auth },
    navidrome: { ...current.navidrome },
    catalog: {
      spotify: { ...current.catalog.spotify },
      providers: { ...current.catalog.providers },
      discovery: { ...current.catalog.discovery }
    },
    naming: { ...current.naming },
    scan: { ...current.scan, extensions: [...current.scan.extensions] },
    cleanup: { ...current.cleanup, emptyFolderExclusions: [...current.cleanup.emptyFolderExclusions] }
  };

  if (update.auth) {
    if (typeof update.auth.enabled === "boolean") {
      next.auth.enabled = update.auth.enabled;
    }
    if (typeof update.auth.username === "string" && update.auth.username.trim()) {
      next.auth.username = update.auth.username.trim();
    }
    if (typeof update.auth.password === "string" && update.auth.password.length > 0) {
      next.auth.passwordHash = await bcrypt.hash(update.auth.password, 12);
    }
  }

  if (update.navidrome) {
    if (typeof update.navidrome.baseUrl === "string") {
      next.navidrome.baseUrl = trimTrailingSlash(update.navidrome.baseUrl.trim());
    }
    if (typeof update.navidrome.username === "string") {
      next.navidrome.username = update.navidrome.username.trim();
    }
    if (typeof update.navidrome.password === "string" && update.navidrome.password.length > 0) {
      next.navidrome.password = update.navidrome.password;
    }
  }

  if (update.catalog?.spotify) {
    if (typeof update.catalog.spotify.clientId === "string") {
      next.catalog.spotify.clientId = update.catalog.spotify.clientId.trim();
    }
    if (typeof update.catalog.spotify.clientSecret === "string" && update.catalog.spotify.clientSecret.length > 0) {
      next.catalog.spotify.clientSecret = update.catalog.spotify.clientSecret;
    }
    if (typeof update.catalog.spotify.market === "string") {
      next.catalog.spotify.market = normalizeSpotifyMarket(update.catalog.spotify.market, next.catalog.spotify.market);
    }
  }

  if (update.catalog?.providers) {
    if (typeof update.catalog.providers.maxConcurrentDownloads === "number") {
      next.catalog.providers.maxConcurrentDownloads = clampInteger(update.catalog.providers.maxConcurrentDownloads, 1, 3, 1);
    }
    next.catalog.providers.opusQuality = normalizeChoice(
      update.catalog.providers.opusQuality,
      [160, 192, 256] as const,
      next.catalog.providers.opusQuality
    );
    if (typeof update.catalog.providers.mp3FallbackEnabled === "boolean") {
      next.catalog.providers.mp3FallbackEnabled = update.catalog.providers.mp3FallbackEnabled;
    }
    next.catalog.providers.mp3FallbackQuality = normalizeChoice(
      update.catalog.providers.mp3FallbackQuality,
      [192, 256, 320] as const,
      next.catalog.providers.mp3FallbackQuality
    );
  }

  if (update.catalog?.discovery) {
    if (typeof update.catalog.discovery.requestsPerMinute === "number") {
      next.catalog.discovery.requestsPerMinute = clampInteger(update.catalog.discovery.requestsPerMinute, 10, 60, 40);
    }
  }

  if (update.naming) {
    next.naming = normalizeNamingSettings(next.naming, update.naming);
  }

  if (update.scan) {
    next.scan = normalizeScanSettings(next.scan, update.scan);
  }

  if (update.cleanup) {
    next.cleanup = normalizeCleanupSettings(next.cleanup, update.cleanup);
  }

  await saveSettings(next);
  return next;
}

async function createDefaultSettings(): Promise<PrivateSettings> {
  return {
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: await bcrypt.hash("admin", 12)
    },
    navidrome: {
      baseUrl: "",
      username: "",
      password: ""
    },
    catalog: defaultCatalog,
    naming: defaultNaming,
    scan: defaultScan,
    cleanup: defaultCleanup
  };
}

export function normalizeSettings(partial: Partial<PrivateSettings>): PrivateSettings {
  const fallback = {
    auth: {
      enabled: true,
      username: "admin"
    },
    navidrome: {
      baseUrl: "",
      username: "",
      password: ""
    },
    catalog: defaultCatalog,
    naming: defaultNaming,
    scan: defaultScan,
    cleanup: defaultCleanup
  };

  return {
    auth: {
      enabled: partial.auth?.enabled ?? fallback.auth.enabled,
      username: partial.auth?.username || fallback.auth.username,
      passwordHash: partial.auth?.passwordHash || getFallbackPasswordHash()
    },
    navidrome: {
      baseUrl: trimTrailingSlash(partial.navidrome?.baseUrl || fallback.navidrome.baseUrl),
      username: partial.navidrome?.username || fallback.navidrome.username,
      password: partial.navidrome?.password || fallback.navidrome.password
    },
    catalog: normalizeCatalogSettings(partial.catalog),
    naming: normalizeNamingSettings(fallback.naming, partial.naming),
    scan: normalizeScanSettings(fallback.scan, partial.scan),
    cleanup: normalizeCleanupSettings(fallback.cleanup, partial.cleanup)
  };
}

function normalizeNamingSettings(
  fallback: PrivateSettings["naming"],
  partial: Partial<PrivateSettings["naming"]> | undefined
): PrivateSettings["naming"] {
  const compacted = compactStringValues(partial ?? {});
  return {
    ...fallback,
    ...compacted,
    mode: "standard" as const,
    ...standardNamingFormatDefaults
  };
}

function normalizeCatalogSettings(
  partial: Partial<PrivateSettings["catalog"]> | undefined
): PrivateSettings["catalog"] {
  const spotify: Partial<PrivateSettings["catalog"]["spotify"]> = partial?.spotify ?? {};
  const providers: Partial<PrivateSettings["catalog"]["providers"]> = partial?.providers ?? {};
  const discovery: Partial<PrivateSettings["catalog"]["discovery"]> = partial?.discovery ?? {};

  return {
    spotify: {
      clientId:
        typeof spotify.clientId === "string"
          ? spotify.clientId.trim()
          : defaultCatalog.spotify.clientId,
      clientSecret:
        typeof spotify.clientSecret === "string"
          ? spotify.clientSecret
          : defaultCatalog.spotify.clientSecret,
      market: normalizeSpotifyMarket(spotify.market, defaultCatalog.spotify.market)
    },
    providers: {
      maxConcurrentDownloads: clampInteger(
        providers.maxConcurrentDownloads,
        1,
        3,
        defaultCatalog.providers.maxConcurrentDownloads
      ),
      opusQuality: normalizeChoice(
        providers.opusQuality,
        [160, 192, 256] as const,
        defaultCatalog.providers.opusQuality
      ),
      mp3FallbackEnabled:
        typeof providers.mp3FallbackEnabled === "boolean"
          ? providers.mp3FallbackEnabled
          : defaultCatalog.providers.mp3FallbackEnabled,
      mp3FallbackQuality: normalizeChoice(
        providers.mp3FallbackQuality,
        [192, 256, 320] as const,
        defaultCatalog.providers.mp3FallbackQuality
      )
    },
    discovery: {
      requestsPerMinute: clampInteger(
        discovery.requestsPerMinute,
        10,
        60,
        defaultCatalog.discovery.requestsPerMinute
      )
    }
  };
}

function normalizeScanSettings(
  fallback: PrivateSettings["scan"],
  partial: Partial<PrivateSettings["scan"]> | undefined
): PrivateSettings["scan"] {
  return {
    extensions: normalizeExtensions(partial?.extensions || fallback.extensions),
    autoScanEnabled:
      typeof partial?.autoScanEnabled === "boolean" ? partial.autoScanEnabled : fallback.autoScanEnabled,
    autoScanTime: normalizeAutoScanTime(partial?.autoScanTime, fallback.autoScanTime)
  };
}

function normalizeCleanupSettings(
  fallback: PrivateSettings["cleanup"],
  partial: Partial<PrivateSettings["cleanup"]> | undefined
): PrivateSettings["cleanup"] {
  return {
    emptyFolderExclusions: normalizeRelativeFolderExclusions(
      partial?.emptyFolderExclusions ?? fallback.emptyFolderExclusions
    )
  };
}

function normalizeSpotifyMarket(value: unknown, fallback: string) {
  const market = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(market) ? market : fallback;
}

function normalizeAutoScanTime(value: unknown, fallback: string) {
  const time = typeof value === "string" ? value.trim() : "";
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeChoice<const T extends readonly number[]>(
  value: unknown,
  choices: T,
  fallback: T[number]
): T[number] {
  const parsed = Number(value);
  return choices.includes(parsed as T[number]) ? (parsed as T[number]) : fallback;
}

function normalizeExtensions(extensions: string[]) {
  const normalized = extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));

  return Array.from(new Set(normalized));
}

function normalizeRelativeFolderExclusions(paths: unknown) {
  if (!Array.isArray(paths)) {
    return [];
  }

  const normalized = paths
    .map((value) => (typeof value === "string" ? value : ""))
    .map((value) => value.replace(/\\/g, "/").replace(/\/+/g, "/").trim())
    .map((value) => value.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter((value) => value && value !== ".")
    .filter((value) => !value.split("/").some((segment) => segment === ".."));

  return Array.from(new Set(normalized));
}

function compactStringValues<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => {
      if (typeof value !== "string") {
        return typeof value !== "undefined";
      }
      return value.trim().length > 0;
    })
  ) as Partial<T>;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function getFallbackPasswordHash() {
  fallbackPasswordHash ??= bcrypt.hashSync("admin", 12);
  return fallbackPasswordHash;
}
