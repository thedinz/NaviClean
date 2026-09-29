import path from "node:path";
import type { OrganizeChangeField, OrganizeChangeKind, OrganizeFieldChange, TrackFile } from "../shared/types.js";

type LayoutFields = Record<OrganizeChangeField, string>;

const changeKindRank: Record<OrganizeChangeKind, number> = {
  none: 0,
  cosmetic: 1,
  "track-number": 2,
  year: 3,
  layout: 4,
  identity: 5
};
const identityFields = new Set<OrganizeChangeField>(["albumArtist", "album", "title"]);
const fieldOrder: OrganizeChangeField[] = ["albumArtist", "album", "year", "track", "title"];
const structuredPathIssues = [
  "Embedded metadata used unknown placeholders; used structured path metadata",
  "Embedded metadata conflicted with structured path; used structured path metadata"
];

/**
 * Explains a proposed move field by field: which parts of the standard path change, whether a change
 * is only formatting, and where each new value came from. The riskiest change names the move's kind.
 */
export function analyzeOrganizeChange(
  track: TrackFile,
  sourceRelativePath: string,
  targetRelativePath: string
): { changeKind: OrganizeChangeKind; changes: OrganizeFieldChange[] } {
  if (!targetRelativePath || sourceRelativePath === targetRelativePath) {
    return { changeKind: "none", changes: [] };
  }

  const target = parseStandardPath(targetRelativePath);
  const source = parseStandardPath(sourceRelativePath);

  if (!target) {
    return { changeKind: "layout", changes: [] };
  }

  if (!source) {
    // The file is not in the standard layout yet, so there is no old value to compare with.
    return {
      changeKind: "layout",
      changes: fieldOrder.map((field) => ({
        field,
        from: null,
        to: target[field],
        cosmetic: false,
        source: fieldSource(track, field, target[field])
      }))
    };
  }

  const changes = fieldOrder
    .filter((field) => source[field] !== target[field])
    .map((field) => ({
      field,
      from: source[field],
      to: target[field],
      cosmetic: looseKey(source[field]) === looseKey(target[field]),
      source: fieldSource(track, field, target[field])
    }));

  let changeKind: OrganizeChangeKind = changes.length === 0 ? "cosmetic" : "none";
  for (const change of changes) {
    const kind: OrganizeChangeKind = change.cosmetic
      ? "cosmetic"
      : identityFields.has(change.field)
        ? "identity"
        : change.field === "year"
          ? "year"
          : "track-number";
    if (changeKindRank[kind] > changeKindRank[changeKind]) {
      changeKind = kind;
    }
  }

  return { changeKind, changes };
}

/**
 * Reads `{Album Artist}/{Album Artist} - {Album} ({Year})/{Album Artist} - {Album} ({Year}) - {slot} - {Title}.ext`.
 * The release folder name anchors the split, so artist and album names containing " - " still parse.
 */
export function parseStandardPath(relativePath: string): LayoutFields | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length !== 3) {
    return null;
  }

  const [artistFolder, releaseFolder, filename] = parts;
  const release = releaseFolder.match(/^(.+) \((\d{4}|Unknown Year)\)$/);
  // Folder names lose trailing dots ("skeler." becomes "skeler"), but the release name keeps them.
  const artistPrefix = release?.[1].match(new RegExp(`^${escapeRegExp(artistFolder)}\\.* - `, "i"));
  if (!release || !artistPrefix) {
    return null;
  }

  const name = path.posix.parse(filename).name;
  const releasePrefix = `${releaseFolder} - `;
  if (!name.toLowerCase().startsWith(releasePrefix.toLowerCase())) {
    return null;
  }

  const slot = name.slice(releasePrefix.length).match(/^(\d{2,3}(?:-\d{2,3})?) - (.+)$/);
  if (!slot) {
    return null;
  }

  return {
    albumArtist: artistFolder,
    album: release[1].slice(artistPrefix[0].length),
    year: release[2],
    track: slot[1],
    title: slot[2]
  };
}

/** Where a proposed value came from, phrased for someone deciding whether to trust it. */
export function fieldSource(track: TrackFile, field: OrganizeChangeField, value: string) {
  const origin = metadataOrigin(track);
  if (field !== "year" || value === "Unknown Year") {
    return origin;
  }

  if (track.originalYear && value === String(track.originalYear) && track.originalYear !== track.year) {
    return `${origin} (original release year; this release is dated ${track.year ?? "unknown"})`;
  }

  if (track.originalYear && value === String(track.originalYear)) {
    return `${origin} (original release year)`;
  }

  return `${origin} (release date)`;
}

function metadataOrigin(track: TrackFile) {
  const identification = track.identification;

  if (identification?.status === "trackkeep-confirmed") {
    return "TrackKeep identity";
  }
  if (track.metadataConfidence === "spotify") {
    return "the Spotify release you selected";
  }
  if (track.metadataConfidence === "trusted-path") {
    return "the folder you trusted";
  }
  if (identification?.source === "musicbrainz" && identification.status === "user-confirmed") {
    return "the MusicBrainz release you selected";
  }
  if (identification?.status === "fingerprint-and-release-confirmed") {
    return "MusicBrainz, matched by audio fingerprint";
  }
  if (track.targetSource === "navidrome") {
    return "Navidrome's database";
  }
  if (track.metadataConfidence === "path-suggestion") {
    return "the file and folder names (unverified)";
  }
  if (track.issues.some((issue) => structuredPathIssues.includes(issue))) {
    return "the current file and folder names";
  }
  return "this file's own tags";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case, accents, punctuation and spacing removed: two values with the same key differ only cosmetically. */
export function looseKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
