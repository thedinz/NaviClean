import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeCollisionCandidate } from "../src/shared/types.js";
import { rankCollisionCandidates, withSuggestedTrashCandidates } from "../src/client/lib/organize-collisions.js";

test("the lower-scored file of a collision is suggested for the recycle bin", () => {
  const items = [{ id: "a", collision: { duplicateKeyMatches: true, candidates: [candidate("source", 790), candidate("existing-target", 1340)] } }];

  assert.deepEqual(withSuggestedTrashCandidates(items, {}), { a: "source" });
});

test("on equal scores the larger file is kept, then the file already at the target", () => {
  assert.equal(rankCollisionCandidates([candidate("source", 790, 200), candidate("existing-target", 790, 100)])?.[0].id, "source");
  assert.equal(rankCollisionCandidates([candidate("source", 790), candidate("existing-target", 790)])?.[0].id, "existing-target");
});

test("nothing is suggested when a file has no score", () => {
  const items = [{ id: "a", collision: { duplicateKeyMatches: false, candidates: [candidate("source", 790), candidate("existing-target", null)] } }];

  assert.equal(rankCollisionCandidates(items[0].collision.candidates), null);
  assert.deepEqual(withSuggestedTrashCandidates(items, {}), {});
});

test("a reviewer's own choice, including clearing the suggestion, is kept", () => {
  const items = [{ id: "a", collision: { duplicateKeyMatches: true, candidates: [candidate("source", 790), candidate("existing-target", 1340)] } }];

  assert.deepEqual(withSuggestedTrashCandidates(items, { a: "existing-target" }), { a: "existing-target" });
  assert.deepEqual(withSuggestedTrashCandidates(items, { a: "" }), { a: "" });
});

function candidate(role: OrganizeCollisionCandidate["role"], qualityScore: number | null, size = 100): OrganizeCollisionCandidate {
  return {
    id: role,
    trackId: role === "existing-target" ? null : role,
    role,
    absolutePath: `/music/${role}.mp3`,
    relativePath: `${role}.mp3`,
    targetRelativePath: "target.mp3",
    artist: "",
    albumArtist: "",
    album: "",
    albumType: "",
    title: role,
    extension: ".mp3",
    size,
    duration: null,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    qualityScore,
    duplicateKey: ""
  };
}
