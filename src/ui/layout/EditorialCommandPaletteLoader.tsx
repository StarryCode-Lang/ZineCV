import { lazy, Suspense } from "react";
import type { EditorialCommand } from "./EditorialCommandPalette";

const EditorialCommandPalette = lazy(() => import("./EditorialCommandPalette"));

export function EditorialCommandPaletteLoader(props: {
  commands: EditorialCommand[];
  loadState: "loading" | "ready" | "error";
  onClose: () => void;
  initialQuery?: string;
  resumeTitle: string;
  workspaceLabel: string;
}) {
  return (
    <Suspense fallback={null}>
      <EditorialCommandPalette {...props} />
    </Suspense>
  );
}
