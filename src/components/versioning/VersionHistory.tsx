import type {
  ResumeCommit,
  ResumeVersionStore,
} from "../../domain/version-model";
import { BranchTree } from "./BranchTree";

// The graph is the single place to browse and act on the complete history.
export function VersionHistory({
  store,
  importedTemplateNames,
  dirty,
  disabled,
  onRestore,
  onJump,
  onDelete,
}: {
  store: ResumeVersionStore;
  importedTemplateNames: Readonly<Record<string, string>>;
  dirty: boolean;
  disabled: boolean;
  onRestore: (commit: ResumeCommit) => void;
  onJump: (commit: ResumeCommit) => void;
  onDelete: (commit: ResumeCommit) => void;
}) {
  return (
    <section className="version-history" data-version-section="history">
      <BranchTree
        store={store}
        importedTemplateNames={importedTemplateNames}
        dirty={dirty}
        onRestore={onRestore}
        onJump={onJump}
        onDelete={onDelete}
        disabled={disabled}
      />
    </section>
  );
}
