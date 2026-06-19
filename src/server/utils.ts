import crypto from "node:crypto";
import path from "node:path";

const illegalFilenameChars = /[<>:"/\\|?*\u0000-\u001f]/g;
const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sha1(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

type NormalizeForMatchOptions = {
  removeBracketedText?: boolean;
};

export function normalizeForMatch(value: string, options: NormalizeForMatchOptions = {}) {
  const removeBracketedText = options.removeBracketedText ?? true;
  let normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft|featuring)\.?\b.*$/g, "");

  if (removeBracketedText) {
    normalized = normalized.replace(/\([^)]*\)|\[[^\]]*]/g, " ");
  }

  return normalized
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function cleanDisplayValue(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function titleFromFilename(filePath: string) {
  const parsed = path.parse(filePath);
  return parsed.name
    .replace(/^[\s._-]*\d{1,3}([\s._-]+|$)/, "")
    .replace(/^[\s._-]*\d{1,2}[\s._-]*-[\s._-]*\d{1,3}([\s._-]+|$)/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || parsed.name;
}

export function sanitizePathSegment(value: string, replaceIllegalCharacters: boolean) {
  let segment = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ");

  if (replaceIllegalCharacters) {
    segment = segment.replace(illegalFilenameChars, " - ");
  }

  segment = segment
    .replace(/\s+-\s+/g, " - ")
    .replace(/\.+$/g, "")
    .trim();

  if (!segment) {
    segment = "Unknown";
  }

  if (reservedWindowsNames.test(segment)) {
    segment = `_${segment}`;
  }

  return segment.slice(0, 120);
}

export function isInsidePath(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toPosixRelative(root: string, target: string) {
  return path.relative(root, target).split(path.sep).join("/");
}

