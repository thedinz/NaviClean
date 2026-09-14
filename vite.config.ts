import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

function currentBranch() {
  if (process.env.VITE_APP_BRANCH) {
    return process.env.VITE_APP_BRANCH;
  }

  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_BRANCH": JSON.stringify(currentBranch())
  },
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  }
});
