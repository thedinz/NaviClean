import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLidarrNamingConfig } from "../src/server/lidarr.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("times out hanging Lidarr naming requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };

  try {
    await assert.rejects(
      fetchLidarrNamingConfig(settings(), { timeoutMs: 10 }),
      /Timed out connecting to Lidarr after 10ms\./
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function settings(): PrivateSettings {
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
      }
    },
    scan: {
      extensions: [".mp3"]
    }
  };
}
