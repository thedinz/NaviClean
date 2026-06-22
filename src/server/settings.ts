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
const defaultNaming = {
  mode: "standard" as const,
  libraryPath: process.env.NAVICLEAN_MUSIC_DIR || "/music",
  recycleBinPath: path.join(process.env.NAVICLEAN_MUSIC_DIR || "/music", ".naviclean-trash"),
  artistFolderFormat: "{Album Artist Name}",
  standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
  multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
  replaceIllegalCharacters: true,
  colonReplacementFormat: 4
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
    scan: settings.scan
  };
}

export async function updateSettings(update: SettingsUpdate): Promise<PrivateSettings> {
  const current = await loadSettings();
  const next: PrivateSettings = {
    auth: { ...current.auth },
    navidrome: { ...current.navidrome },
    naming: { ...current.naming },
    scan: { extensions: [...current.scan.extensions] }
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

  if (update.naming) {
    next.naming = normalizeNamingSettings(next.naming, update.naming);
  }

  if (update.scan?.extensions) {
    next.scan.extensions = normalizeExtensions(update.scan.extensions);
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
    naming: defaultNaming,
    scan: {
      extensions: defaultExtensions
    }
  };
}

function normalizeSettings(partial: Partial<PrivateSettings>): PrivateSettings {
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
    naming: defaultNaming,
    scan: {
      extensions: defaultExtensions
    }
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
    naming: normalizeNamingSettings(fallback.naming, partial.naming),
    scan: {
      extensions: normalizeExtensions(partial.scan?.extensions || fallback.scan.extensions)
    }
  };
}

function normalizeNamingSettings(
  fallback: PrivateSettings["naming"],
  partial: Partial<PrivateSettings["naming"]> | undefined
) {
  const compacted = compactStringValues(partial ?? {});
  const mode = normalizeNamingMode(compacted.mode, fallback.mode);
  const colonReplacementFormat = normalizeColonReplacementFormat(
    compacted.colonReplacementFormat,
    fallback.colonReplacementFormat
  );
  const merged: PrivateSettings["naming"] = {
    ...fallback,
    ...compacted,
    mode,
    colonReplacementFormat
  };

  if (mode === "standard") {
    return {
      ...merged,
      artistFolderFormat: defaultNaming.artistFolderFormat,
      standardTrackFormat: defaultNaming.standardTrackFormat,
      multiDiscTrackFormat: defaultNaming.multiDiscTrackFormat,
      replaceIllegalCharacters: defaultNaming.replaceIllegalCharacters,
      colonReplacementFormat: defaultNaming.colonReplacementFormat
    };
  }

  return merged;
}

function normalizeNamingMode(value: unknown, fallback: NamingMode): NamingMode {
  if (value === "standard" || value === "manual") {
    return value;
  }

  if (value === "spotifybu") {
    return "standard";
  }

  if (value === "lidarr") {
    return "manual";
  }

  return fallback;
}

function normalizeColonReplacementFormat(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 4 ? parsed : fallback;
}

function normalizeExtensions(extensions: string[]) {
  const normalized = extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));

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
