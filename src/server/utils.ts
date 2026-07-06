import crypto from "node:crypto";
import path from "node:path";

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

export function repairUtf16MojibakeText(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  let repaired = "";
  let suspiciousUnits = 0;
  let utf16LikeUnits = 0;

  for (const char of trimmed) {
    const codePoint = char.codePointAt(0);

    if (typeof codePoint !== "number" || codePoint > 0xffff) {
      continue;
    }

    const highByte = codePoint >> 8;
    const lowByte = codePoint & 0xff;

    if (codePoint > 0xff && highByte >= 0x20 && highByte <= 0x7e) {
      repaired += String.fromCharCode(highByte);
      suspiciousUnits += 1;

      if (lowByte === 0 || lowByte === 0xfe) {
        utf16LikeUnits += 1;
      }
      continue;
    }

    if (codePoint <= 0xff && /\s/.test(char) && suspiciousUnits > 0) {
      repaired += " ";
    }
  }

  const cleaned = repaired.replace(/\s+/g, " ").trim();

  if (
    suspiciousUnits < 4 ||
    utf16LikeUnits / suspiciousUnits < 0.6 ||
    cleaned.replace(/\s/g, "").length < 3 ||
    !/[a-z0-9]/i.test(cleaned)
  ) {
    return null;
  }

  return cleaned;
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

export function isInsidePath(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toPosixRelative(root: string, target: string) {
  return path.relative(root, target).split(path.sep).join("/");
}

