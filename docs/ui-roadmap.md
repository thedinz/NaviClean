# NaviClean UI roadmap

Status: reviewed and approved direction, not yet implemented  
Branch: `dev`  
Reviewed: 2026-09-14

This document records the agreed dashboard direction and the page-by-page UI audit. The goal is to improve hierarchy and clarity without redesigning pages merely for novelty.

## Product-wide changes

### Implement

- Keep the current dark sidebar and teal visual identity.
- Replace the always-present **NaviClean scan** header action with a page-specific primary action. Scanning remains the dashboard action; other pages use their own relevant action or no header action.
- Remove the permanent **Whole-library caution** banner from every page. Show safety language next to the action it governs: organizing, converting, recycling, downloading, or permanent deletion.
- Stop repeating an uppercase eyebrow and the same page title directly beneath it. Use one clear page title and an optional useful subtitle.
- Use neutral summary totals by default. Apply warning/danger emphasis only to a non-zero value that needs attention.
- Reduce decorative status chips and duplicated counts. A value should appear once unless the second occurrence serves a different interaction, such as a filter.
- Do not render result controls that cannot currently do anything. Empty pages should not show disabled pagination, filters, selection totals, or bulk actions.
- Never render a success-style empty state at the same time as an error. Configuration/path errors should replace the empty state and include a direct Settings action when appropriate.
- Make branch/version information accurate. The current development build reports `Branch main` while running `dev`.
- Replace the tablet breakpoint's ten-column icon grid with a compact navigation rail. Use a menu/drawer on narrow mobile widths so all eleven normal pages, plus optional Diagnostics, remain discoverable.
- Continue migrating component colors to semantic theme variables. Hard-coded light surfaces are already leaking into dark mode in Settings.

## Dashboard — implement approved concept

Priority: highest

- Title the page **Library overview** and show the last catalog update beneath it.
- Keep one header action: **Scan library**.
- Use a compact four-metric row: Tracks, Duplicate groups, Pending moves, and Needs review.
- Highlight only metrics with an actionable non-zero value.
- Make **Cleanup workflow** the primary panel directly below the metrics.
- Show Scan, Organize, and Duplicates as a three-step state summary with one contextual next action.
- Combine NaviClean catalog status and Navidrome index status into one compact **Index & scans** panel.
- Replace the large caution banner with a one-line safety reminder. Keep stronger warnings on the actual Apply surfaces.

Reference concept: the approved streamlined dashboard mockup from the 2026-09-14 review.

## Login — leave alone

Priority: none

- The centered panel, field order, button hierarchy, and light/dark presentation are clear.
- Do not redesign it as part of the dashboard work.

## Instructions — keep layout, correct and tighten content

Priority: low

- Keep the three scan explanation cards, run order, and common-scenarios structure.
- Correct the stale claim that NaviClean "enriches matches from Navidrome." Under the identity-first model, Navidrome is an index comparison and coordination source, not naming authority.
- Remove the global scan button and global caution banner through the product-wide shell change.
- Avoid adding more cards, diagrams, or controls; this page already has enough structure.

## Library — leave the core page alone

Priority: low

- Keep the breadcrumb drill-down, search, artist/album cards, and track table.
- Keep destructive actions available with confirmation; they are part of the library-management purpose.
- Apply only the product-wide shell and responsive-navigation changes.
- Later, verify long metadata summaries against a realistic large library, but do not redesign based on the one-item development catalog.

## Empty Folders — preserve layout, fix states

Priority: medium

- Keep the summary/action toolbar and result table.
- When the library path cannot be read, replace **No empty folders** with one configuration error state and a **Review library path** action.
- Hide or defer **Move selected to trash** until there is a selection; do not leave a visually prominent danger button disabled in the zero state.
- Use the same error, empty, loading, and selected-action patterns as Non-Music Files.

## Non-Music Files — preserve table, simplify the shell

Priority: medium

- Keep grouping by type, expandable details, classification, examples, and per-file cleanup.
- Use the same configuration-error state as Empty Folders instead of simultaneously reporting an unreadable path and "No non-music files."
- Remove or subordinate the audio-file count; it is context rather than the purpose of this page.
- Show the bulk trash action only after one or more groups are selected.

## Diagnostics — simplify empty state; keep populated detail

Priority: medium-low because the page is advanced/optional

- In the zero state, hide reason filters, search, selection actions, and pagination. Never show `0 of 0` pagination.
- Show the GitHub issue-report prompt only when a real unmatched item or failed match investigation is visible.
- Keep the detailed match checks and candidate comparison structure when results exist; its density is justified for an advanced diagnostic tool.
- Apply the shared cleanup toolbar/error-state pattern.

## Discover — improve setup and search hierarchy

Priority: high

- When Spotify is disabled or missing credentials, replace the disabled search experience with a clear setup state and a Settings action.
- Keep the search input and Search button together as one bounded control group instead of placing them at opposite ends of a full-width panel.
- Turn the permanent Spotify/provider disclaimer into quiet supporting text while browsing. Retain explicit rights and bulk-risk confirmations at the actual download step.
- Keep the populated artist grid, album grid, track table, provider preview, and job progress structure.
- Do not add dashboard-like metrics to this page.

## Organize — substantial cleanup

Priority: highest with Dashboard

- Remove the introductory warning panel once safety guidance is placed next to Apply.
- Use one source of truth for counts. The current summary chips and filter tabs repeat the same information.
- Reduce the nine always-visible filter segments. Keep the important filters visible and place the rest in a compact filter control; preserve counts inside the chosen filter UI.
- Hide pagination when all results fit on one page.
- Replace the four-column path-heavy table with a clearer three-part row: **Status**, **Current → proposed path**, and **Resolve**. Preserve path detail, but give it room to wrap deliberately.
- Rename metadata-focused language to identity-focused language where appropriate, matching the new TrackKeep/fingerprint/MusicBrainz model.
- Show selection actions only when a row is selected.
- Keep Apply as the sole primary action, with the ready-item count in its label and a nearby, contextual safety note.
- Collapse verbose Navidrome/index notes unless they block the current operation.

## Convert — leave the core page alone

Priority: low

- Keep the source format, target format, quality controls, conversion summary, search, selection tools, and file table.
- Keep the conversion-specific warning because it accurately explains replacement and lossy-to-lossless limitations.
- Remove only the product-wide caution duplication.
- Consolidate the repeated selection totals when touching this page, but do not otherwise redesign it.

## Duplicates — simplify gating, keep group comparison

Priority: medium

- When organization blocks duplicate cleanup, show one blocker panel with the reason and one **Review organization** action. Remove the three repeated blocker/warning/empty messages.
- When unlocked, keep duplicate groups and quality comparisons.
- Add one concise instruction above results: users select the copies to recycle, and NaviClean will always keep at least one copy.
- Keep the local review-before-recycling warning near the destructive action; remove the unrelated global caution.

## Trash — simplify zero and selection states

Priority: medium-high

- Present the recycle-bin path as muted context, not a warning-colored banner.
- When Trash is empty, hide search, type filter, Restore selected, Delete selected, and Empty trash. Keep only Refresh and the empty state.
- When items exist, keep search and type filtering together in one toolbar.
- Reveal Restore/Delete actions when the user has a selection.
- Separate **Empty trash** from ordinary selection actions because it has a different and much larger scope.
- Keep the existing table columns; original and trash paths are useful here.

## Settings — targeted improvements, not a full redesign

Priority: high for correctness, medium for layout

- Fix dark mode for empty-folder exclusion rows; they currently retain a light background and nearly invisible text.
- Keep the existing cards and two-column desktop layout. Auth, Navidrome, Spotify, Audio identification, Provider downloads, and Library are sensible groupings.
- Add connection status labels such as **Connected**, **Not configured**, or **Disabled** to Navidrome, Spotify, and AcoustID sections.
- Make the Save bar sticky and show whether there are unsaved changes.
- Change the yellow NaviClean naming callout to neutral information; the stable naming contract is not a warning.
- Keep Test actions inside their relevant connection cards.

## Implementation order

1. Product-wide shell: contextual header actions, caution placement, responsive navigation, theme-variable cleanup.
2. Approved Dashboard redesign.
3. Organize simplification and identity-first wording.
4. Settings dark-mode correction and sticky save state.
5. Shared cleanup/error/empty-state component for Empty Folders, Non-Music Files, Diagnostics, and Trash.
6. Discover setup/search improvements.
7. Duplicates blocked-state consolidation.
8. Instructions content correction and small Convert cleanup.
9. Regression pass across light/dark desktop, tablet, and mobile layouts.
