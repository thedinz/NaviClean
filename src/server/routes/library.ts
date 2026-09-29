import { Router } from "express";
import type { TrackFile } from "../../shared/types.js";
import { loadCatalog, saveCatalog } from "../catalog.js";
import { clampInteger, HttpError, mutation, requireAdvancedDiagnostics, requireList, requireString, route } from "../http.js";
import {
  buildLibraryAlbums,
  buildLibraryArtists,
  deleteEmptyLibraryFolders,
  findLibraryAlbumTracks,
  findLibraryArtistTracks,
  listEmptyLibraryFolders,
  trashLibraryTracks
} from "../library.js";
import { fetchNavidromeArtwork } from "../navidrome.js";
import { listNonMusicFileGroup, listNonMusicFiles, trashNonMusicFileGroups, trashNonMusicFiles } from "../non-music.js";
import { invalidateOrganizeEvaluationCache } from "../organize-service.js";
import { loadSettings, updateSettings } from "../settings.js";
import { findUnindexedNavidromeMatches, listUnindexedFiles, trashUnindexedFiles } from "../unindexed.js";

const defaultArtistPageSize = 25;
const maxArtistPageSize = 100;
const missingArtistMessage = "Artist is no longer in the catalog. Scan or refresh before continuing.";
const missingAlbumMessage = "Album is no longer in the catalog. Scan or refresh before continuing.";

export const libraryRouter = Router();

libraryRouter.get("/tracks", route(async (req, res) => {
  const catalog = await loadCatalog();
  const search = String(req.query.search || "").toLowerCase().trim();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const tracks = catalog.tracks
    .filter((track) =>
      !search ||
      [track.artist, track.albumArtist, track.album, track.title, track.relativePath].join(" ").toLowerCase().includes(search)
    )
    .slice(0, limit);

  res.json({ tracks, total: catalog.tracks.length });
}));

libraryRouter.get("/library/artists", route(async (req, res) => {
  const catalog = await loadCatalog();
  const pageSize = clampInteger(Number(req.query.pageSize || defaultArtistPageSize), defaultArtistPageSize, 1, maxArtistPageSize);
  const requestedPage = clampInteger(Number(req.query.page || 1), 1, 1, Number.MAX_SAFE_INTEGER);
  const artists = buildLibraryArtists(catalog.tracks, String(req.query.search || ""));
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(artists.length / pageSize)));
  const start = (page - 1) * pageSize;

  res.json({
    artists: artists.slice(start, start + pageSize),
    artistTotal: artists.length,
    page,
    pageSize,
    total: catalog.tracks.length
  });
}));

libraryRouter.get("/library/artists/:artistId/albums", route(async (req, res) => {
  const catalog = await loadCatalog();
  const albums = buildLibraryAlbums(catalog.tracks, String(req.params.artistId || ""), String(req.query.search || ""));

  if (!albums) {
    throw new HttpError(404, missingArtistMessage);
  }

  res.json({ albums });
}));

libraryRouter.get("/library/artists/:artistId/albums/:albumId/tracks", route(async (req, res) => {
  const catalog = await loadCatalog();
  const tracks = findLibraryAlbumTracks(catalog.tracks, String(req.params.artistId || ""), String(req.params.albumId || ""));

  if (!tracks) {
    throw new HttpError(404, missingAlbumMessage);
  }

  res.json({ tracks });
}));

libraryRouter.delete("/library/artists/:artistId", mutation(async (req, res) => {
  const catalog = await loadCatalog();
  const tracks = findLibraryArtistTracks(catalog.tracks, String(req.params.artistId || ""));

  if (!tracks) {
    throw new HttpError(404, missingArtistMessage);
  }

  res.json(await trashCatalogTracks(catalog.tracks, tracks));
}));

libraryRouter.delete("/library/artists/:artistId/albums/:albumId", mutation(async (req, res) => {
  const catalog = await loadCatalog();
  const tracks = findLibraryAlbumTracks(catalog.tracks, String(req.params.artistId || ""), String(req.params.albumId || ""));

  if (!tracks) {
    throw new HttpError(404, missingAlbumMessage);
  }

  res.json(await trashCatalogTracks(catalog.tracks, tracks));
}));

libraryRouter.delete("/library/tracks/:trackId", mutation(async (req, res) => {
  const catalog = await loadCatalog();
  const track = catalog.tracks.find((candidate) => candidate.id === String(req.params.trackId || ""));

  if (!track) {
    throw new HttpError(404, "Track is no longer in the catalog. Scan or refresh before continuing.");
  }

  res.json(await trashCatalogTracks(catalog.tracks, [track]));
}));

libraryRouter.get("/library/artwork/:type", route(async (req, res) => {
  const type = String(req.params.type || "");
  const artist = String(req.query.artist || "").trim();
  const album = String(req.query.album || "").trim();
  const year = String(req.query.year || "").trim();
  const size = clampInteger(Math.round(Number(req.query.size || 360)), 360, 96, 720);

  if (type !== "artist" && type !== "album") {
    throw new HttpError(400, "Artwork type must be artist or album.");
  }

  if (!artist || (type === "album" && !album)) {
    throw new HttpError(400, "Artwork lookup is missing artist or album metadata.");
  }

  const artwork = await fetchNavidromeArtwork(
    await loadSettings(),
    type === "album" ? { type, artist, album, year } : { type, artist },
    size
  );

  if (!artwork) {
    res.status(404).end();
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=86400");
  res.type(artwork.contentType);
  res.send(artwork.data);
}));

libraryRouter.get("/library/empty-folders", route(async (_req, res) => {
  res.json(await listEmptyLibraryFolders(await loadSettings()));
}));

libraryRouter.post("/library/empty-folders/exclusions", route(async (req, res) => {
  const relativePath = requireString(req.body?.relativePath, "relativePath is required");
  const settings = await loadSettings();
  const next = await updateSettings({
    cleanup: {
      emptyFolderExclusions: [...settings.cleanup.emptyFolderExclusions, relativePath]
    }
  });

  res.json({
    emptyFolders: await listEmptyLibraryFolders(next),
    exclusions: next.cleanup.emptyFolderExclusions
  });
}));

libraryRouter.delete("/library/empty-folders", mutation(async (req, res) => {
  const ids = requireList(req.body?.ids, "ids are required");
  res.json(await deleteEmptyLibraryFolders(await loadSettings(), ids));
}));

libraryRouter.get("/library/non-music-files", route(async (_req, res) => {
  res.json(await listNonMusicFiles(await loadSettings()));
}));

libraryRouter.get("/library/non-music-files/group", route(async (req, res) => {
  const groupKey = requireString(req.query.key, "key is required");
  res.json(await listNonMusicFileGroup(await loadSettings(), groupKey));
}));

libraryRouter.post("/library/non-music-files/trash", mutation(async (req, res) => {
  const groupKeys = requireList(req.body?.groupKeys, "groupKeys are required");
  res.json(await trashNonMusicFileGroups(await loadSettings(), groupKeys));
}));

libraryRouter.post("/library/non-music-files/trash-files", mutation(async (req, res) => {
  const fileIds = requireList(req.body?.fileIds, "fileIds are required");
  res.json(await trashNonMusicFiles(await loadSettings(), fileIds, String(req.body?.groupKey || "")));
}));

libraryRouter.use("/library/unindexed", requireAdvancedDiagnostics);

libraryRouter.get("/library/unindexed", route(async (_req, res) => {
  const catalog = await loadCatalog();
  res.json(listUnindexedFiles(await loadSettings(), catalog.tracks));
}));

libraryRouter.post("/library/unindexed/trash", mutation(async (req, res) => {
  const trackIds = requireList(req.body?.trackIds, "trackIds are required");
  const catalog = await loadCatalog();
  const result = await trashUnindexedFiles(await loadSettings(), catalog.tracks, trackIds);

  await saveCatalog(result.tracks);
  invalidateOrganizeEvaluationCache();
  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    unindexed: result.unindexed
  });
}));

libraryRouter.get("/library/unindexed/:trackId/navidrome-matches", route(async (req, res) => {
  const catalog = await loadCatalog();
  res.json(await findUnindexedNavidromeMatches(await loadSettings(), catalog.tracks, String(req.params.trackId || "")));
}));

async function trashCatalogTracks(catalogTracks: TrackFile[], selected: TrackFile[]) {
  const result = await trashLibraryTracks(await loadSettings(), catalogTracks, selected.map((track) => track.id));

  await saveCatalog(result.tracks);
  invalidateOrganizeEvaluationCache();
  return {
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors
  };
}
