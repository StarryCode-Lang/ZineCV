import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EditorialCommand } from "../layout/EditorialCommandPalette";
import type { EditorialCommandInput } from "../layout/editorial-commands";
import { EditorialCommandPaletteLoader } from "../layout/EditorialCommandPaletteLoader";

export function useEditorialCommandPalette({
  commandInput,
  resumeTitle,
  workspaceLabel,
  onBeforeOpen,
  enabled = true,
}: {
  commandInput: EditorialCommandInput;
  resumeTitle: string;
  workspaceLabel: string;
  onBeforeOpen: () => void;
  enabled?: boolean;
}): {
  commandPalette: ReactNode;
  openCommandPalette: (initialQuery?: string) => void;
} {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [commands, setCommands] = useState<EditorialCommand[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "ready",
  );
  const commandInputRef = useRef(commandInput);
  const loadSequence = useRef(0);
  commandInputRef.current = commandInput;

  const openCommandPalette = useCallback(
    (query = "") => {
      if (!enabled) return;
      onBeforeOpen();
      setInitialQuery(query);
      setOpen(true);
      setLoadState("loading");
      const sequence = ++loadSequence.current;
      void import("../layout/editorial-commands")
        .then(({ createEditorialCommands }) => {
          if (sequence !== loadSequence.current) return;
          setCommands(createEditorialCommands(commandInputRef.current));
          setLoadState("ready");
        })
        .catch(() => {
          if (sequence === loadSequence.current) setLoadState("error");
        });
    },
    [enabled, onBeforeOpen],
  );

  useEffect(() => {
    if (!enabled) { setOpen(false); return; }
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k")
        return;
      event.preventDefault();
      if (open) setOpen(false);
      else openCommandPalette();
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [enabled, open, openCommandPalette]);

  return {
    openCommandPalette,
    commandPalette: open ? (
      <EditorialCommandPaletteLoader
        commands={commands}
        loadState={loadState}
        initialQuery={initialQuery}
        resumeTitle={resumeTitle}
        workspaceLabel={workspaceLabel}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
}
