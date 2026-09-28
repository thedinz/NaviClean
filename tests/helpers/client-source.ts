import fs from "node:fs/promises";
import path from "node:path";

const clientRoot = new URL("../../src/client/", import.meta.url);

/** Every client module's source, so UI regression checks do not depend on which file holds the code. */
export async function clientSource() {
  const files = await listSourceFiles(clientRoot.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const contents = await Promise.all(files.sort().map((file) => fs.readFile(file, "utf8")));
  return contents.join("\n");
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(fullPath);
      return /\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith(".css") ? [fullPath] : [];
    })
  );
  return nested.flat();
}
