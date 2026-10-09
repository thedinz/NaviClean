import { Download, FolderInput, Fingerprint, RefreshCw } from "lucide-react";
import { Section } from "../components/ui";

const identitySteps = [
  {
    title: "MusicBrainz IDs already in your tags",
    body: "Files tagged by Picard, beets, or NaviClean carry recording and release IDs. They are trusted immediately, with no lookup and no review."
  },
  {
    title: "Audio fingerprint",
    body: "With AcoustID enabled, fpcalc fingerprints the audio and AcoustID resolves it to MusicBrainz recordings. A unique release match can be accepted automatically."
  },
  {
    title: "MusicBrainz text search",
    body: "Anything still unidentified is searched by its tags, one album folder at a time. These matches always wait for you to confirm in Organize."
  },
  {
    title: "Your decision",
    body: "Confirm a release, choose a Spotify match, trust a well-named folder, or skip the track. Decisions are remembered by fingerprint or path."
  }
];

const downloadSteps = [
  "Search: YouTube and JioSaavn are searched and every result is scored for title, artist, length, and album. Live, remix, cover, karaoke, sped-up, and re-upload results are penalized; official Topic uploads get a bonus.",
  "Decide: a score of 80 or more downloads automatically, 55 to 80 waits in the review queue, and anything lower goes to Wanted. You can change both thresholds in Settings.",
  "Verify: the download must meet your quality floor, match the release track's length, and, when AcoustID is on, fingerprint as the same song. A source that fails is quarantined and the next candidate is tried.",
  "Import: the file is tagged with the release metadata, cover art, and MusicBrainz IDs, then moved to its standard path. Navidrome picks it up on its next scan."
];

const scenarios = [
  ["New music was added", "Navidrome quick scan, then NaviClean scan."],
  ["NaviClean organized or moved files", "Navidrome full scan, then NaviClean scan."],
  ["Many folders were renamed outside NaviClean", "Navidrome full scan, then NaviClean scan."],
  ["A download keeps failing", "Check the Review and Wanted tabs; paste a known-good link if the automatic search keeps missing."],
  ["Only NaviClean's totals look old", "Run a NaviClean scan. Unchanged files are reused, so rescans are quick."]
];

export function GuidePage() {
  return (
    <div className="page-stack guide">
      <Section title={<><RefreshCw size={18} /> Scans</>}>
        <div className="guide-grid">
          <div className="guide-card">
            <h3>NaviClean scan</h3>
            <p>Reads tags from the mounted library and identifies each track. Unchanged files are reused from the cache, so only new or modified files are read again. You can cancel a scan at any time, and the next one picks up where it stopped.</p>
          </div>
          <div className="guide-card">
            <h3>Navidrome quick scan</h3>
            <p>Uses Navidrome's change detection. Good for routine additions and small tag edits.</p>
          </div>
          <div className="guide-card">
            <h3>Navidrome full scan</h3>
            <p>Walks everything again. Use it after NaviClean moves files, or whenever Navidrome's index looks stale.</p>
          </div>
        </div>
      </Section>

      <Section title={<><Fingerprint size={18} /> How tracks are identified</>} description="Identification stops at the first confident answer.">
        <ol className="guide-steps">
          {identitySteps.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              <span>{step.body}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={<><FolderInput size={18} /> Organizing</>}>
        <p>
          Organize previews the standard layout, <code>Artist / Artist - Album (Year) / Artist - Album (Year) - 01 - Title</code>, for every identified track. Applying a plan writes the confirmed tags (including Picard-standard MusicBrainz IDs) and then moves the file. Duplicate cleanup unlocks once nothing is left to organize.
        </p>
      </Section>

      <Section title={<><Download size={18} /> How downloads work</>}>
        <ol className="guide-steps numbered">
          {downloadSteps.map((step) => <li key={step}><span>{step}</span></li>)}
        </ol>
      </Section>

      <Section title="Common situations">
        <div className="scenario-list">
          {scenarios.map(([title, steps]) => (
            <div className="scenario-row" key={title}>
              <strong>{title}</strong>
              <span>{steps}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
