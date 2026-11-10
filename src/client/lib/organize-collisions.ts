import type { OrganizeCollisionCandidate, OrganizePlanItem } from "../../shared/types";

const keepRoleOrder: Record<OrganizeCollisionCandidate["role"], number> = {
  // On a tie, keep the file already at the target: it needs no move.
  "existing-target": 0,
  source: 1,
  "same-target": 2
};

/**
 * Collision candidates from the one to keep to the one to remove: higher quality score, then the
 * larger file. Null when any candidate has no score, since then there is no safe suggestion.
 */
export function rankCollisionCandidates(candidates: OrganizeCollisionCandidate[]) {
  if (candidates.length < 2 || candidates.some((candidate) => typeof candidate.qualityScore !== "number")) {
    return null;
  }

  return [...candidates].sort((left, right) =>
    (right.qualityScore! - left.qualityScore!) ||
    ((right.size ?? 0) - (left.size ?? 0)) ||
    (keepRoleOrder[left.role] - keepRoleOrder[right.role])
  );
}

/** Pre-selects the lowest-ranked file of every collision the reviewer has not decided on yet. */
export function withSuggestedTrashCandidates(items: Pick<OrganizePlanItem, "id" | "collision">[], selectedCandidates: Record<string, string>) {
  const next = { ...selectedCandidates };

  for (const item of items) {
    const ranked = item.collision && !(item.id in next) ? rankCollisionCandidates(item.collision.candidates) : null;
    if (ranked) {
      next[item.id] = ranked[ranked.length - 1].id;
    }
  }

  return next;
}
