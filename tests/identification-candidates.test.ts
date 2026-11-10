import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrackFile, TrackIdentificationCandidate } from "../src/shared/types.js";
import { matchedIdentificationCandidate } from "../src/client/lib/identification-candidates.js";

test("a release the user picked is shown as confirmed", () => {
  assert.deepEqual(matchedIdentificationCandidate(identification("user-confirmed")), { id: "b", confirmed: true });
});

test("an automatic fingerprint match is pointed out but left for the user to confirm", () => {
  assert.deepEqual(matchedIdentificationCandidate(identification("fingerprint-and-release-confirmed")), { id: "b", confirmed: false });
});

test("ambiguous fingerprints and tracks without a release match point at no candidate", () => {
  assert.equal(matchedIdentificationCandidate(identification("recording-identified-release-ambiguous")), null);
  assert.equal(matchedIdentificationCandidate({ ...identification("user-confirmed")!, releaseId: undefined }), null);
  assert.equal(matchedIdentificationCandidate(undefined), null);
});

function identification(status: string): TrackFile["identification"] {
  return {
    status,
    source: "musicbrainz",
    message: "",
    recordingId: "rec-1",
    releaseId: "rel-2",
    candidates: [candidate("a", "rel-1"), candidate("b", "rel-2")]
  } as TrackFile["identification"];
}

function candidate(id: string, releaseId: string) {
  return { id, recordingId: "rec-1", releaseId, artist: "A", title: "T", album: "Al", score: 1 } as TrackIdentificationCandidate;
}
