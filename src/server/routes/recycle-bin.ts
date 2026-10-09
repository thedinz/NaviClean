import { Router } from "express";
import { mutation, requireList, route } from "../http.js";
import { deleteRecycleBinItems, emptyRecycleBin, listRecycleBin, restoreRecycleBinItems } from "../recycle-bin.js";
import { loadSettings } from "../settings.js";

export const recycleBinRouter = Router();

recycleBinRouter.get("/recycle-bin", route(async (_req, res) => {
  res.json(await listRecycleBin(await loadSettings()));
}));

// Deleting from the recycle bin never touches library files or the catalog, so it is not locked.
recycleBinRouter.delete("/recycle-bin", route(async (_req, res) => {
  res.json(await emptyRecycleBin(await loadSettings()));
}));

recycleBinRouter.delete("/recycle-bin/items", route(async (req, res) => {
  const ids = requireList(req.body?.ids, "ids are required");
  res.json(await deleteRecycleBinItems(await loadSettings(), ids));
}));

recycleBinRouter.post("/recycle-bin/restore", mutation(async (req, res) => {
  const ids = requireList(req.body?.ids, "ids are required");
  res.json(await restoreRecycleBinItems(await loadSettings(), ids));
}));
