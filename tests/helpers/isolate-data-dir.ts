import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Preloaded by `npm test` so no test reads or writes the developer's own `.data/` folder.
 * Each test process gets a fresh temporary data directory; tests that need a specific one still set
 * NAVICLEAN_DATA_DIR themselves before importing server modules.
 */
const prefix = "naviclean-test-data-";
const staleAfterMs = 60 * 60 * 1000;

removeStaleDataDirs();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
process.env.NAVICLEAN_DATA_DIR = dataDir;

process.on("exit", () => removeQuietly(dataDir));

/** Windows cannot remove a database that is still open at exit, so earlier runs can leave folders behind. */
function removeStaleDataDirs() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(prefix)) continue;
    const directory = path.join(os.tmpdir(), name);
    try {
      if (Date.now() - fs.statSync(directory).mtimeMs > staleAfterMs) removeQuietly(directory);
    } catch {
      // Another test process removed it first.
    }
  }
}

function removeQuietly(directory: string) {
  try {
    fs.rmSync(directory, { force: true, recursive: true });
  } catch {
    // Still in use; a later run removes it once it is stale.
  }
}
