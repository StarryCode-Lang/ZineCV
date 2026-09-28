export type DraftSaveStatus = "saving" | "retrying" | "saved" | "failed";

export type DraftSaveState = {
  status: DraftSaveStatus;
  label: string;
};
