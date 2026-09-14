import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "../src/server/settings.js";

test("provider download settings default to Opus 192 with MP3 320 fallback", () => {
  const settings = normalizeSettings({});
  assert.deepEqual(settings.catalog.providers, {
    maxConcurrentDownloads: 1,
    opusQuality: 192,
    mp3FallbackEnabled: true,
    mp3FallbackQuality: 320
  });
});

test("provider download settings preserve valid choices and normalize invalid old values", () => {
  const valid = normalizeSettings({
    catalog: { providers: {
      maxConcurrentDownloads: 2,
      opusQuality: 256,
      mp3FallbackEnabled: false,
      mp3FallbackQuality: 192
    } } as never
  });
  assert.deepEqual(valid.catalog.providers, {
    maxConcurrentDownloads: 2,
    opusQuality: 256,
    mp3FallbackEnabled: false,
    mp3FallbackQuality: 192
  });
  const reloaded = normalizeSettings(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(reloaded.catalog.providers, valid.catalog.providers);

  const invalid = normalizeSettings({
    catalog: { providers: {
      maxConcurrentDownloads: 99,
      opusQuality: 320,
      mp3FallbackEnabled: "yes",
      mp3FallbackQuality: 128
    } } as never
  });
  assert.deepEqual(invalid.catalog.providers, {
    maxConcurrentDownloads: 3,
    opusQuality: 192,
    mp3FallbackEnabled: true,
    mp3FallbackQuality: 320
  });
});

test("identity settings migrate safely and Spotify has an explicit switch", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.catalog.spotify.enabled, true);
  assert.deepEqual(defaults.identification, {
    acoustIdEnabled: false,
    acoustIdApiKey: "",
    useEmbeddedTagsAsHints: true,
    usePathAsHints: true,
    autoAcceptUniqueFingerprintMatches: true,
    requireReviewBeforeFileChanges: true
  });

  const configured = normalizeSettings({
    catalog: { spotify: { enabled: false } } as never,
    identification: {
      acoustIdEnabled: true,
      acoustIdApiKey: " key ",
      useEmbeddedTagsAsHints: false,
      usePathAsHints: false,
      autoAcceptUniqueFingerprintMatches: false,
      requireReviewBeforeFileChanges: false
    }
  });
  assert.equal(configured.catalog.spotify.enabled, false);
  assert.deepEqual(configured.identification, {
    acoustIdEnabled: true,
    acoustIdApiKey: "key",
    useEmbeddedTagsAsHints: false,
    usePathAsHints: false,
    autoAcceptUniqueFingerprintMatches: false,
    requireReviewBeforeFileChanges: false
  });
});
