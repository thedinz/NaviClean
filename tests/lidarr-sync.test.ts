import assert from "node:assert/strict";
import { test } from "node:test";
import type { LidarrNamingConfig } from "../src/server/lidarr.js";
import { refreshLidarrNamingSettings } from "../src/server/lidarr-sync.js";
import type { PrivateSettings } from "../src/server/settings.js";

const latestNaming: LidarrNamingConfig = {
  artistFolderFormat: "{Artist CleanName}",
  standardTrackFormat: "{Album Artist Name}/{Album Title}/{track:00} - {Track Title}",
  multiDiscTrackFormat: "{Album Artist Name}/{Album Title}/{medium:00}-{track:00} - {Track Title}",
  replaceIllegalCharacters: false,
  colonReplacementFormat: 2
};

test("refreshes and saves Lidarr naming when configured", async () => {
  let saved: PrivateSettings | null = null;

  const refreshed = await refreshLidarrNamingSettings(settings(), {
    fetchNaming: async () => latestNaming,
    save: async (next) => {
      saved = next;
    }
  });

  assert.equal(refreshed.naming.artistFolderFormat, latestNaming.artistFolderFormat);
  assert.equal(refreshed.naming.standardTrackFormat, latestNaming.standardTrackFormat);
  assert.equal(refreshed.naming.multiDiscTrackFormat, latestNaming.multiDiscTrackFormat);
  assert.equal(refreshed.naming.replaceIllegalCharacters, latestNaming.replaceIllegalCharacters);
  assert.equal(refreshed.naming.colonReplacementFormat, latestNaming.colonReplacementFormat);
  assert.equal(saved?.naming.standardTrackFormat, latestNaming.standardTrackFormat);
});

test("keeps cached naming when Lidarr refresh fails", async () => {
  const cached = settings();

  const refreshed = await refreshLidarrNamingSettings(cached, {
    fetchNaming: async () => {
      throw new Error("Lidarr offline");
    },
    save: async () => {
      throw new Error("Should not save");
    }
  });

  assert.equal(refreshed, cached);
});

test("does not contact Lidarr outside Lidarr naming mode", async () => {
  let called = false;
  const cached = settings({ mode: "spotifybu" });

  const refreshed = await refreshLidarrNamingSettings(cached, {
    fetchNaming: async () => {
      called = true;
      return latestNaming;
    }
  });

  assert.equal(refreshed, cached);
  assert.equal(called, false);
});

function settings(overrides: Partial<PrivateSettings["naming"]> = {}): PrivateSettings {
  return {
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: ""
    },
    navidrome: {
      baseUrl: "",
      username: "",
      password: ""
    },
    naming: {
      mode: "lidarr",
      libraryPath: "/music",
      recycleBinPath: "/music/.naviclean-trash",
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4,
      lidarr: {
        baseUrl: "http://lidarr:8686",
        apiKey: "secret"
      },
      ...overrides
    },
    scan: {
      extensions: [".mp3"]
    }
  };
}
