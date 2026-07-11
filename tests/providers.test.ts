import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  providerDownloadProfile,
  providerMetadataArgsForSpotifyTrack,
  providerTrackToTrackFile,
  providerYtDlpArgs,
  shouldNormalizeStagedAudioFile,
  withProviderFormatFallback,
  writeOggOpusPictureMetadataFile,
  writeTaggedAudioFile,
  type CatalogProviderTrack
} from "../src/server/providers.js";
import { normalizeSettings } from "../src/server/settings.js";

const execFileAsync = promisify(execFile);

test("planning uses the configured Opus profile and .opus path", () => {
  const settings = normalizeSettings({});
  const planned = providerTrackToTrackFile(settings, providerTrack());
  assert.equal(planned.extension, ".opus");
  assert.equal(planned.codec, "Opus");
  assert.equal(planned.container, "Ogg Opus");
  assert.equal(planned.bitrate, 192_000);
  assert.match(planned.relativePath, /\.opus$/);
});

test("yt-dlp receives the selected Opus format and cap", () => {
  const args = providerYtDlpArgs({
    downloadUrl: "https://youtube.com/watch?v=abcdefghi",
    format: "opus",
    outputTemplate: "track.%(ext)s",
    quality: 256
  });
  assert.deepEqual(args.slice(args.indexOf("--audio-format"), args.indexOf("--audio-format") + 4),
    ["--audio-format", "opus", "--audio-quality", "256K"]);
  assert.equal(args[args.indexOf("--format") + 1], "bestaudio[abr<=256]/bestaudio/best");
});

test("Opus format failures retry MP3 at its configured quality and destination format", async () => {
  const settings = normalizeSettings({ catalog: { providers: { mp3FallbackQuality: 256 } } as never });
  const attempts: string[] = [];
  const result = await withProviderFormatFallback(settings, async (format) => {
    attempts.push(format);
    if (format === "opus") throw new Error("ffmpeg libopus encoder failed");
    return providerDownloadProfile(settings, format);
  });
  assert.deepEqual(attempts, ["opus", "mp3"]);
  assert.equal(result.extension, ".mp3");
  assert.equal(result.quality, 256);
});

test("disabled fallback reports the original Opus failure without retrying", async () => {
  const settings = normalizeSettings({ catalog: { providers: { mp3FallbackEnabled: false } } as never });
  const attempts: string[] = [];
  await assert.rejects(
    withProviderFormatFallback(settings, async (format) => {
      attempts.push(format);
      throw new Error("ffmpeg could not write header");
    }),
    /could not write header/
  );
  assert.deepEqual(attempts, ["opus"]);
});

test("Opus metadata includes release, compilation, ISRC, and SpotifyBU identity tags", () => {
  const args = providerMetadataArgsForSpotifyTrack(providerTrack());
  const values = args.filter((_, index) => args[index - 1] === "-metadata");
  assert.ok(values.includes("isrc=USRC17607839"));
  assert.ok(values.includes("releasedate=2026-07-10"));
  assert.ok(values.includes("compilation=1"));
  assert.ok(values.some((value) => value.startsWith("spotifybu:track_id=")));
});

test("large Opus artwork is written through ffmetadata rather than argv", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-opus-art-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const coverPath = path.join(directory, "cover.jpg");
  await fs.writeFile(coverPath, Buffer.alloc(300_000, 0x5a));
  const metadataPath = await writeOggOpusPictureMetadataFile(path.join(directory, "track.opus"), coverPath);
  const stat = await fs.stat(metadataPath);
  assert.ok(stat.size > 300_000);
  assert.ok(path.basename(metadataPath).endsWith(".ffmetadata"));
});

test("lower-bitrate Opus is kept while over-cap Opus is normalized downward", async (t) => {
  if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) {
    t.skip("ffmpeg and ffprobe are required for media regression coverage");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-opus-cap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const low = path.join(directory, "low.opus");
  const high = path.join(directory, "high.opus");
  await createOpus(low, 96);
  await createOpus(high, 256);
  assert.equal(await shouldNormalizeStagedAudioFile({ format: "opus", quality: 192, stagedPath: low }), false);
  assert.equal(await shouldNormalizeStagedAudioFile({ format: "opus", quality: 160, stagedPath: high }), true);
});

test("Opus tags and METADATA_BLOCK_PICTURE can be read back", async (t) => {
  if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) {
    t.skip("ffmpeg and ffprobe are required for media regression coverage");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-opus-tags-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.opus");
  const tagged = path.join(directory, "tagged.opus");
  const cover = path.join(directory, "cover.png");
  await createOpus(source, 96);
  await fs.writeFile(cover, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
  await writeTaggedAudioFile(source, tagged, providerMetadataArgsForSpotifyTrack(providerTrack()), cover);
  const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", tagged]);
  const tags = (JSON.parse(stdout.toString()) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
  const normalized = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(normalized.title, "Test Track");
  assert.equal(normalized.isrc, "USRC17607839");
  assert.ok(normalized.metadata_block_picture?.length > 20);
});

async function commandAvailable(command: string) {
  try { await execFileAsync(command, ["-version"]); return true; } catch { return false; }
}

async function createOpus(filePath: string, bitrate: number) {
  await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "libopus", "-b:a", `${bitrate}k`, filePath]);
}

function providerTrack(): CatalogProviderTrack {
  return {
    album: "Test Album", albumId: "album-id", albumArtist: "Various Artists",
    albumImageUrl: null, albumReleaseDate: "2026-07-10", albumReleaseYear: 2026,
    albumTracksTotal: 12, albumType: "compilation", artists: ["Test Artist"],
    discNumber: 1, durationMs: 180_000, id: "track-id", isrc: "USRC17607839",
    name: "Test Track", spotifyUrl: "https://open.spotify.com/track/track-id", trackNumber: 3
  };
}
