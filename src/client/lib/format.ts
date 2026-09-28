import type {
  OrganizeCollisionCandidate,
  TrackFile
} from "../../shared/types";
import type { OrganizePreviewItem } from "../pages/OrganizePage";

export function navidromeMatchMethodLabel(method: NonNullable<OrganizePreviewItem["navidromeEnrichment"]>["matchMethod"]) {
  if (method === "absolute-path") {
    return "absolute path";
  }

  if (method === "relative-path") {
    return "relative path";
  }

  if (method === "filename-size") {
    return "filename+size";
  }

  if (method === "metadata-size-relaxed-duration") {
    return "metadata+size";
  }

  if (method === "edition-metadata-size") {
    return "edition metadata+size";
  }

  if (method === "metadata-size-title-suffix") {
    return "metadata+size title suffix";
  }

  if (method === "edition-title-suffix-metadata-size") {
    return "edition+title suffix metadata+size";
  }

  if (method === "metadata-size-track-agnostic") {
    return "metadata+size no track";
  }

  if (method === "metadata-size-artist-agnostic") {
    return "metadata+size no artist";
  }

  return "metadata key";
}

export function isTrackKeepManaged(value: TrackFile["managedBy"]) {
  // The SpotifyBU value can still arrive from persisted data written before the rename.
  return value === "trackkeep" || value === "spotifybu";
}

export function pathDirectory(value: string) {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index >= 0 ? value.slice(0, index) : "";
}

export function pathFilename(value: string) {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index >= 0 ? value.slice(index + 1) : value;
}

export function libraryMeta(values: string[]) {
  return values.filter(Boolean).join(" / ");
}

export function navidromeScanTypeLabel(value?: string | null) {
  switch (value) {
    case "quick":
      return "Quick scan";
    case "full":
      return "Full scan";
    case "quick-selective":
      return "Quick selective scan";
    case "full-selective":
      return "Full selective scan";
    default:
      return value ? value.replaceAll("-", " ") : "No scan type";
  }
}

export function navidromeScanActionLabel(value?: string | null) {
  return value ? navidromeScanTypeLabel(value) : "Scan";
}

export function issueLabel(count: number) {
  return count > 0 ? `${count} metadata ${count === 1 ? "issue" : "issues"}` : "";
}

export function pluralize(value: string, count: number) {
  return count === 1 ? value : `${value}s`;
}

export function trackNumberLabel(track: TrackFile) {
  const trackNumber = track.trackNumber ? track.trackNumber.toString().padStart(2, "0") : "--";

  if (track.discNumber && track.discNumber > 1) {
    return `${track.discNumber}-${trackNumber}`;
  }

  return trackNumber;
}

export function albumReleaseLabel(track: TrackFile) {
  return [track.albumType, track.year || "Unknown Year", track.album].filter(Boolean).join(" - ");
}

export function collisionRoleLabel(candidate: OrganizeCollisionCandidate) {
  if (candidate.role === "source") {
    return "Source file";
  }

  if (candidate.role === "existing-target") {
    return "Existing target";
  }

  return "Same target";
}

export function qualitySummary(file: TrackFile | OrganizeCollisionCandidate) {
  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : "FILE";
  const qualityParts = [
    extension,
    file.lossless ? "lossless" : "",
    file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : "",
    file.sampleRate ? `${Math.round(file.sampleRate / 1000)}kHz` : "",
    file.bitsPerSample ? `${file.bitsPerSample}-bit` : "",
    file.duration ? formatDuration(file.duration) : "",
    typeof file.size === "number" ? formatBytes(file.size) : "",
    typeof file.qualityScore === "number" ? `score ${Math.round(file.qualityScore)}` : ""
  ];

  return qualityParts.filter(Boolean).join(" / ");
}

export function diffText(value: string, compareTo: string) {
  if (!compareTo || value === compareTo) {
    return [{ text: value, changed: false }];
  }

  let start = 0;
  while (start < value.length && start < compareTo.length && value[start] === compareTo[start]) {
    start += 1;
  }

  let valueEnd = value.length - 1;
  let compareEnd = compareTo.length - 1;
  while (valueEnd >= start && compareEnd >= start && value[valueEnd] === compareTo[compareEnd]) {
    valueEnd -= 1;
    compareEnd -= 1;
  }

  return [
    { text: value.slice(0, start), changed: false },
    { text: value.slice(start, valueEnd + 1), changed: true },
    { text: value.slice(valueEnd + 1), changed: false }
  ].filter((part) => part.text.length > 0);
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatScanDate(value: string) {
  return Number.isFinite(Date.parse(value)) ? formatDate(value) : value;
}

export function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function formatProviderDuration(value?: number) {
  return typeof value === "number" ? formatDuration(value / 1000) : "Unknown length";
}

export function providerLabel(value: string) {
  return value === "jiosaavn" ? "JioSaavn" : "YouTube";
}

/** "3 min ago", "in 2 h", "yesterday"… for timestamps near now. */
export function formatRelative(value: string | null | undefined, now = Date.now()) {
  if (!value) {
    return "never";
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 30) return format.format(Math.round(seconds / 86_400), "day");
  return formatDate(value);
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`) {
  return `${count.toLocaleString()} ${count === 1 ? noun : pluralNoun}`;
}
