import { Router } from "express";
import { loadCatalog } from "../catalog.js";
import { HttpError, optionalStringList, requireString, route } from "../http.js";
import { buildLibraryArtists } from "../library.js";
import { loadSettings } from "../settings.js";
import {
  buildSpotifyDownloadPlan,
  getSpotifyAlbumDetail,
  getSpotifyArtistDiscography,
  matchLibraryArtistsToSpotify,
  searchSpotifyArtists,
  searchSpotifyTrackMetadata,
  testSpotifyConnection
} from "../spotify.js";

export const spotifyRouter = Router();

spotifyRouter.post("/spotify/test", route(async (req, res) => {
  res.json(await testSpotifyConnection(await loadSettings(), req.body));
}));

spotifyRouter.get("/spotify/artists/search", route(async (req, res) => {
  res.json({
    artists: await searchSpotifyArtists(await loadSettings(), String(req.query.query || ""))
  });
}));

spotifyRouter.get("/spotify/tracks/search", route(async (req, res) => {
  const trackId = String(req.query.trackId || "");
  const catalog = await loadCatalog();
  const track = catalog.tracks.find((candidate) => candidate.id === trackId);

  if (!track) {
    throw new HttpError(404, "The local track is no longer in the current scan.");
  }

  const requestedQuery = String(req.query.query || "").trim();
  const knownArtist = /^(?:\[?unknown artist\]?|unknown)$/i.test(track.albumArtist || track.artist)
    ? ""
    : track.albumArtist || track.artist;
  const query = requestedQuery || [knownArtist, track.title].filter(Boolean).join(" ");
  res.json(await searchSpotifyTrackMetadata(await loadSettings(), query));
}));

spotifyRouter.get("/spotify/library-artists", route(async (req, res) => {
  const catalog = await loadCatalog();
  const artists = buildLibraryArtists(catalog.tracks, String(req.query.search || ""));
  const limit = Number(req.query.limit || 12);

  res.json({
    matches: await matchLibraryArtistsToSpotify(
      await loadSettings(),
      artists.map((artist) => ({ id: artist.id, name: artist.name })),
      Number.isFinite(limit) ? limit : 12
    )
  });
}));

spotifyRouter.get("/spotify/artists/:artistId/discography", route(async (req, res) => {
  const catalog = await loadCatalog();
  res.json(await getSpotifyArtistDiscography(await loadSettings(), catalog.tracks, String(req.params.artistId)));
}));

spotifyRouter.get("/spotify/albums/:albumId", route(async (req, res) => {
  const catalog = await loadCatalog();
  res.json({
    album: await getSpotifyAlbumDetail(await loadSettings(), catalog.tracks, String(req.params.albumId))
  });
}));

spotifyRouter.post("/spotify/download-plan", route(async (req, res) => {
  const albumId = requireString(req.body.spotifyAlbumId, "spotifyAlbumId is required");
  const catalog = await loadCatalog();

  res.json({
    plan: await buildSpotifyDownloadPlan(await loadSettings(), catalog.tracks, albumId, optionalStringList(req.body.trackIds))
  });
}));
