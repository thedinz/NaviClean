import { Tabs } from "../components/ui";
import { navigate, type Route } from "../lib/router";
import { EmptyFoldersPage, NonMusicFilesPage } from "./CleanupPages";

type CleanupTab = "empty-folders" | "non-music";

export function CleanupPage({ route, onOpenSettings }: { route: Route; onOpenSettings: () => void }) {
  const tab: CleanupTab = route.params.get("tab") === "non-music" ? "non-music" : "empty-folders";

  return (
    <div className="page-stack">
      <Tabs<CleanupTab>
        label="Cleanup tools"
        value={tab}
        onChange={(next) => navigate("cleanup", { tab: next })}
        tabs={[
          { id: "empty-folders", label: "Empty folders" },
          { id: "non-music", label: "Non-music files" }
        ]}
      />
      {tab === "empty-folders" ? (
        <EmptyFoldersPage onOpenSettings={onOpenSettings} />
      ) : (
        <NonMusicFilesPage onOpenSettings={onOpenSettings} />
      )}
    </div>
  );
}
