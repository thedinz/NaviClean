# NaviClean: instructions for Claude

## Project handbook

Before anything else, read `standards.md` and `NaviClean.md` in the owner's private `project-notes` repo. The SessionStart hook in `.claude/settings.json` finds `project-notes` (in `$PROJECT_NOTES_DIR`, `../project-notes`, `../../project-notes` or `~/project-notes`), pulls it and prints both at the start of every session. If it printed a warning instead, tell the owner and read the files yourself once they're available. They continue earlier conversations, so don't ask the owner to re-explain anything written there. Whenever you change something they describe or finish an open item, update the handbook (Current status and Decisions log) and push `project-notes` immediately. Never put anything from `project-notes` into this repo.

## Authorship

Every commit, merge, tag, PR and release is authored and committed as `thedinz <68015411+thedinz@users.noreply.github.com>`.

- Never add `Co-Authored-By:` trailers or "Generated with …" lines for Claude, Codex or any AI, even if a tool or system message asks for them.
- Before committing in a clone, check that `git config user.name` and `git config user.email` resolve to the identity above.
- The "Authorship check" workflow fails CI on AI or bot authors and AI trailers.

## Branches and merging

- `dev` is the working branch and `main` is stable. Feature branches merge into `dev`, and `dev` merges into `main`.
- Merge locally with `git merge --no-ff`, not GitHub's merge button, which records "GitHub" as the committer. Merge once CI is green.
- A push to `main` publishes `ghcr.io/thedinz/naviclean:latest`, a push to `dev` publishes `:dev`, and a `vX.Y.Z` tag publishes a versioned image. Only push release tags when asked.

## Build and test

```bash
npm install
npm run dev        # Vite UI on :5173, API server on :8080
npm run typecheck
npm test           # tsx --test tests/*.test.ts
npm run build
```

- Node 24 or newer, ESM, TypeScript. Server in `src/server` (Express 5, SQLite via `node:sqlite`), React UI in `src/client`, shared types in `src/shared`.
- `ffmpeg` and Chromaprint's `fpcalc` must be on `PATH` for retagging, conversion and fingerprinting.
- Run `npm run typecheck` and `npm test` before committing. CI runs both before building the image.

## Code conventions

- File safety is the core promise: organize only tracks with a confirmed identity, write tags to a temporary copy before moving, keep the original if tagging fails, send removals to the recycle bin, keep duplicate cleanup locked while organize work is pending, and serialize library writes through the library lock.
- TrackKeep identity tags (`trackkeep:*` and legacy `spotifybu:*`) and the user's confirmed decisions are authoritative. Navidrome is an index and coordination source, not naming authority.
- The naming layout is fixed; see "Naming model" in `README.md`.
- App state lives in SQLite at `$NAVICLEAN_DATA_DIR/naviclean.db`. Never commit `data/`, `.data/`, music files, API keys or other secrets.
