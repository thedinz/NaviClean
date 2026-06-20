import { fetchLidarrNamingConfig, type LidarrNamingConfig } from "./lidarr.js";
import { saveSettings, type PrivateSettings } from "./settings.js";

type RefreshOptions = {
  fetchNaming?: (settings: PrivateSettings) => Promise<LidarrNamingConfig>;
  save?: (settings: PrivateSettings) => Promise<void>;
};

export async function refreshLidarrNamingSettings(
  settings: PrivateSettings,
  options: RefreshOptions = {}
): Promise<PrivateSettings> {
  if (
    settings.naming.mode !== "lidarr" ||
    !settings.naming.lidarr.baseUrl ||
    !settings.naming.lidarr.apiKey
  ) {
    return settings;
  }

  try {
    const fetchNaming = options.fetchNaming ?? fetchLidarrNamingConfig;
    const next = applyLidarrNamingConfig(settings, await fetchNaming(settings));

    if (!lidarrNamingSettingsEqual(settings, next)) {
      await (options.save ?? saveSettings)(next);
    }

    return next;
  } catch {
    return settings;
  }
}

export function applyLidarrNamingConfig(settings: PrivateSettings, naming: LidarrNamingConfig): PrivateSettings {
  return {
    ...settings,
    naming: {
      ...settings.naming,
      mode: "lidarr",
      artistFolderFormat: naming.artistFolderFormat,
      standardTrackFormat: naming.standardTrackFormat,
      multiDiscTrackFormat: naming.multiDiscTrackFormat,
      replaceIllegalCharacters: naming.replaceIllegalCharacters,
      colonReplacementFormat: naming.colonReplacementFormat
    }
  };
}

function lidarrNamingSettingsEqual(left: PrivateSettings, right: PrivateSettings) {
  return (
    left.naming.artistFolderFormat === right.naming.artistFolderFormat &&
    left.naming.standardTrackFormat === right.naming.standardTrackFormat &&
    left.naming.multiDiscTrackFormat === right.naming.multiDiscTrackFormat &&
    left.naming.replaceIllegalCharacters === right.naming.replaceIllegalCharacters &&
    left.naming.colonReplacementFormat === right.naming.colonReplacementFormat
  );
}
