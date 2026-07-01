import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  EmptyFolderDeleteResult,
  EmptyFolderItem,
  EmptyFolderPreview,
  LibraryAlbumSummary,
  LibraryArtistSummary,
  LibraryTrashResult,
  TrackFile
} from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, normalizeForMatch, sha1, toPosixRelative } from "./utils.js";

type ArtistGroup = {
  id: string;
  key: string;
  name: string;
  tracks: TrackFile[];
};

type AlbumGroup = {
  id: string;
  key: string;
  artistId: string;
  artist: string;
  title: string;
  albumType: string;
  tracks: TrackFile[];
};

export function buildLibraryArtists(tracks: TrackFile[], search = ""): LibraryArtistSummary[] {
  const query = searchQuery(search);

  return buildArtistGroups(tracks)
    .map(artistSummary)
    .filter((artist) => summaryMatches(query, [artist.name, artist.formats.join(" ")]))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export function buildLibraryAlbums(tracks: TrackFile[], artistId: string, search = ""): LibraryAlbumSummary[] | null {
  const artist = findArtistGroup(tracks, artistId);

  if (!artist) {
    return null;
  }

  const query = searchQuery(search);

  return buildAlbumGroups(artist)
    .map(albumSummary)
    .filter((album) => summaryMatches(query, [album.title, album.artist, album.albumType, album.yearLabel, album.formats.join(" ")]))
    .sort(compareAlbums);
}

export function findLibraryArtistTracks(tracks: TrackFile[], artistId: string) {
  return findArtistGroup(tracks, artistId)?.tracks ?? null;
}

export function findLibraryAlbumTracks(tracks: TrackFile[], artistId: string, albumId: string) {
  const artist = findArtistGroup(tracks, artistId);

  if (!artist) {
    return null;
  }

  const album = buildAlbumGroups(artist).find((candidate) => candidate.id === albumId);
  return album ? sortTracks(album.tracks) : null;
}

export async function trashLibraryTracks(
  settings: PrivateSettings,
  tracks: TrackFile[],
  trackIds: string[]
): Promise<LibraryTrashResult & { tracks: TrackFile[] }> {
  const selectedIds = new Set(trackIds);

  if (selectedIds.size === 0) {
    throw new Error("At least one library track is required.");
  }

  const selectedTracks = tracks.filter((track) => selectedIds.has(track.id));
  const selectedTrackIds = new Set(selectedTracks.map((track) => track.id));
  const errors = trackIds
    .filter((id) => !selectedTrackIds.has(id))
    .map((id) => `${id}: track is no longer in the catalog`);
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const trashRoot = safeRecycleBinPath(settings);
  const trashSessionRoot = path.join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const removedTrackIds = new Set<string>();
  const touchedDirectories = new Set<string>();
  let trashed = 0;

  for (const track of selectedTracks) {
    const sourcePath = path.resolve(track.absolutePath);

    if (!isInsidePath(libraryRoot, sourcePath) || sourcePath === libraryRoot) {
      errors.push(`${track.relativePath}: only files inside the configured library can be recycled`);
      continue;
    }

    try {
      const targetPath = path.join(trashSessionRoot, ...track.relativePath.split("/").filter(Boolean));

      if (!isInsidePath(trashSessionRoot, targetPath) || targetPath === trashSessionRoot) {
        errors.push(`${track.relativePath}: recycle target leaves the recycle session folder`);
        continue;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await moveFile(sourcePath, targetPath);
      touchedDirectories.add(path.dirname(sourcePath));
      removedTrackIds.add(track.id);
      trashed += 1;
    } catch (error) {
      errors.push(`${track.relativePath}: ${(error as Error).message}`);
    }
  }

  for (const directory of touchedDirectories) {
    await pruneEmptyDirectories(libraryRoot, directory);
  }

  return {
    trashed,
    removedTrackIds: Array.from(removedTrackIds),
    errors,
    tracks: tracks.filter((track) => !removedTrackIds.has(track.id))
  };
}

export async function listEmptyLibraryFolders(settings: PrivateSettings): Promise<EmptyFolderPreview> {
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const recycleRoot = path.resolve(settings.naming.recycleBinPath);
  const exclusions = new Set(settings.cleanup.emptyFolderExclusions.map((value) => value.toLowerCase()));
  const folders: EmptyFolderItem[] = [];
  const errors: string[] = [];

  await collectEmptyLibraryFolders(libraryRoot, libraryRoot, recycleRoot, exclusions, folders, errors);

  folders.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: "base" }));

  return {
    libraryPath: libraryRoot,
    total: folders.length,
    folders,
    errors
  };
}

export async function deleteEmptyLibraryFolders(
  settings: PrivateSettings,
  folderIds: string[]
): Promise<EmptyFolderDeleteResult> {
  const selectedIds = Array.from(new Set(folderIds.filter(Boolean)));

  if (selectedIds.length === 0) {
    throw new Error("At least one empty folder is required.");
  }

  const before = await listEmptyLibraryFolders(settings);
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const currentFolders = new Map(before.folders.map((folder) => [folder.id, folder]));
  const errors: string[] = [...before.errors];
  let deleted = 0;

  for (const id of selectedIds) {
    const folder = currentFolders.get(id);

    if (!folder) {
      errors.push(`${id}: folder is no longer empty or is not in the current pass`);
      continue;
    }

    const folderPath = path.resolve(libraryRoot, ...folder.relativePath.split("/").filter(Boolean));

    if (!isInsidePath(libraryRoot, folderPath) || folderPath === libraryRoot) {
      errors.push(`${folder.relativePath}: folder is outside the configured library`);
      continue;
    }

    try {
      await fs.rmdir(folderPath);
      deleted += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        errors.push(`${folder.relativePath}: folder is already gone`);
      } else if (code === "ENOTEMPTY" || code === "EEXIST") {
        errors.push(`${folder.relativePath}: folder is no longer empty`);
      } else {
        errors.push(`${folder.relativePath}: ${(error as Error).message}`);
      }
    }
  }

  return {
    deleted,
    errors,
    emptyFolders: await listEmptyLibraryFolders(settings)
  };
}

function buildArtistGroups(tracks: TrackFile[]) {
  const groups = new Map<string, ArtistGroup>();

  for (const track of tracks) {
    const name = artistName(track);
    const key = artistKey(name);
    const group = groups.get(key) ?? {
      id: sha1(`artist:${key}`),
      key,
      name,
      tracks: []
    };

    group.tracks.push(track);
    group.name = preferredDisplayName(group.name, name);
    groups.set(key, group);
  }

  return Array.from(groups.values());
}

function findArtistGroup(tracks: TrackFile[], artistId: string) {
  return buildArtistGroups(tracks).find((group) => group.id === artistId) ?? null;
}

function buildAlbumGroups(artist: ArtistGroup) {
  const groups = new Map<string, AlbumGroup>();

  for (const track of artist.tracks) {
    const title = albumTitle(track);
    const albumType = track.albumType || "Album";
    const key = `${albumKey(title)}|${albumKey(albumType)}`;
    const group = groups.get(key) ?? {
      id: sha1(`album:${artist.key}:${key}`),
      key,
      artistId: artist.id,
      artist: artist.name,
      title,
      albumType,
      tracks: []
    };

    group.tracks.push(track);
    group.title = preferredDisplayName(group.title, title);
    group.albumType = preferredDisplayName(group.albumType, albumType);
    groups.set(key, group);
  }

  return Array.from(groups.values());
}

function artistSummary(group: ArtistGroup): LibraryArtistSummary {
  const albums = buildAlbumGroups(group);

  return {
    id: group.id,
    name: group.name,
    thumbnailLabel: thumbnailLabel(group.name),
    artworkUrl: artworkUrl("artist", {
      artist: group.name
    }),
    albumCount: albums.length,
    trackCount: group.tracks.length,
    totalSize: totalSize(group.tracks),
    formats: formats(group.tracks),
    issueCount: issueCount(group.tracks)
  };
}

function albumSummary(group: AlbumGroup): LibraryAlbumSummary {
  const year = yearLabel(group.tracks);

  return {
    id: group.id,
    artistId: group.artistId,
    artist: group.artist,
    title: group.title,
    albumType: group.albumType || "Album",
    yearLabel: year,
    thumbnailLabel: thumbnailLabel(group.title),
    artworkUrl: artworkUrl("album", {
      artist: group.artist,
      album: group.title,
      year
    }),
    trackCount: group.tracks.length,
    totalSize: totalSize(group.tracks),
    duration: totalDuration(group.tracks),
    formats: formats(group.tracks),
    issueCount: issueCount(group.tracks)
  };
}

function artworkUrl(type: "artist" | "album", params: Record<string, string>) {
  const searchParams = new URLSearchParams();
  searchParams.set("size", "360");

  for (const [key, value] of Object.entries(params)) {
    if (value && value !== "Unknown Year") {
      searchParams.set(key, value);
    }
  }

  return `/api/library/artwork/${type}?${searchParams.toString()}`;
}

function sortTracks(tracks: TrackFile[]) {
  return [...tracks].sort((left, right) => {
    const disc = (left.discNumber ?? 1) - (right.discNumber ?? 1);

    if (disc !== 0) {
      return disc;
    }

    const track = (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER);

    if (track !== 0) {
      return track;
    }

    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
      left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: "base" });
  });
}

function compareAlbums(left: LibraryAlbumSummary, right: LibraryAlbumSummary) {
  const year = albumYearSort(right.yearLabel) - albumYearSort(left.yearLabel);

  if (year !== 0) {
    return year;
  }

  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function albumYearSort(value: string) {
  const years = Array.from(value.matchAll(/\d{4}/g)).map((match) => Number(match[0]));
  return years.length ? Math.max(...years) : 0;
}

function searchQuery(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

function summaryMatches(query: string, values: string[]) {
  if (!query) {
    return true;
  }

  return values.some((value) => normalizeForMatch(value, { removeBracketedText: false }).includes(query));
}

function artistName(track: TrackFile) {
  return track.albumArtist || track.artist || "Unknown Artist";
}

function albumTitle(track: TrackFile) {
  return track.album || "Unknown Album";
}

function artistKey(value: string) {
  return normalizeForMatch(value || "Unknown Artist", { removeBracketedText: false }) || "unknown artist";
}

function albumKey(value: string) {
  return normalizeForMatch(value || "Unknown Album", { removeBracketedText: false }) || "unknown album";
}

function preferredDisplayName(current: string, candidate: string) {
  if (current.startsWith("Unknown") && !candidate.startsWith("Unknown")) {
    return candidate;
  }

  return current;
}

function thumbnailLabel(value: string) {
  const words = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "?";
  }

  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

function totalSize(tracks: TrackFile[]) {
  return tracks.reduce((total, track) => total + track.size, 0);
}

function totalDuration(tracks: TrackFile[]) {
  const durations = tracks.map((track) => track.duration).filter((duration): duration is number => typeof duration === "number");
  return durations.length ? durations.reduce((total, duration) => total + duration, 0) : null;
}

function formats(tracks: TrackFile[]) {
  return Array.from(new Set(tracks.map((track) => track.extension.replace(/^\./, "").toUpperCase()).filter(Boolean))).sort();
}

function issueCount(tracks: TrackFile[]) {
  return tracks.filter((track) => track.issues.length > 0).length;
}

function yearLabel(tracks: TrackFile[]) {
  const years = Array.from(new Set(tracks.map((track) => track.year).filter((year): year is number => typeof year === "number"))).sort(
    (left, right) => left - right
  );

  if (years.length === 0) {
    return "Unknown Year";
  }

  if (years.length === 1) {
    return String(years[0]);
  }

  return `${years[0]}-${years[years.length - 1]}`;
}

async function collectEmptyLibraryFolders(
  libraryRoot: string,
  currentDirectory: string,
  recycleRoot: string,
  exclusions: Set<string>,
  folders: EmptyFolderItem[],
  errors: string[]
) {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch (error) {
    const message = `Unable to read ${currentDirectory}: ${(error as Error).message}`;

    if (currentDirectory === libraryRoot) {
      throw new Error(message);
    }

    errors.push(`${toPosixRelative(libraryRoot, currentDirectory)}: ${(error as Error).message}`);
    return;
  }

  if (currentDirectory !== libraryRoot && entries.length === 0) {
    folders.push(await emptyFolderItem(libraryRoot, currentDirectory));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);

    if (isIgnoredLibraryDirectory(libraryRoot, absolutePath, entry.name, recycleRoot, exclusions)) {
      continue;
    }

    await collectEmptyLibraryFolders(libraryRoot, absolutePath, recycleRoot, exclusions, folders, errors);
  }
}

async function emptyFolderItem(libraryRoot: string, absolutePath: string): Promise<EmptyFolderItem> {
  const relativePath = toPosixRelative(libraryRoot, absolutePath);
  const segments = relativePath.split("/").filter(Boolean);
  const stat = await fs.stat(absolutePath);

  return {
    id: sha1(`empty-folder:${relativePath}`),
    relativePath,
    name: segments.at(-1) || relativePath,
    parentRelativePath: segments.slice(0, -1).join("/"),
    depth: segments.length,
    mtimeMs: stat.mtimeMs
  };
}

function isIgnoredLibraryDirectory(
  libraryRoot: string,
  absolutePath: string,
  name: string,
  recycleRoot: string,
  exclusions: Set<string>
) {
  const relativePath = toPosixRelative(libraryRoot, absolutePath).toLowerCase();

  return (
    path.resolve(absolutePath) === recycleRoot ||
    name === ".naviclean" ||
    name === ".naviclean-trash" ||
    pathMatchesExclusion(relativePath, exclusions)
  );
}

function pathMatchesExclusion(relativePath: string, exclusions: Set<string>) {
  for (const exclusion of exclusions) {
    if (relativePath === exclusion || relativePath.startsWith(`${exclusion}/`)) {
      return true;
    }
  }

  return false;
}

function safeRecycleBinPath(settings: PrivateSettings) {
  const recycleBinPath = path.resolve(settings.naming.recycleBinPath);
  const libraryPath = path.resolve(settings.naming.libraryPath);

  if (recycleBinPath === path.parse(recycleBinPath).root) {
    throw new Error("Recycle bin path cannot be a drive or filesystem root.");
  }

  if (recycleBinPath === libraryPath || isInsidePath(recycleBinPath, libraryPath)) {
    throw new Error("Recycle bin path cannot be the library path or contain the library path.");
  }

  return recycleBinPath;
}

async function moveFile(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    const stat = await fs.stat(source);
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    await fs.chmod(target, stat.mode);
    await fs.utimes(target, stat.atime, stat.mtime);
    await fs.unlink(source);
  }
}

async function pruneEmptyDirectories(root: string, startDirectory: string) {
  let current = path.resolve(startDirectory);
  const resolvedRoot = path.resolve(root);

  while (current !== resolvedRoot && isInsidePath(resolvedRoot, current)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }

      if (code === "ENOTEMPTY" || code === "EEXIST") {
        break;
      }

      throw error;
    }

    current = path.dirname(current);
  }
}
