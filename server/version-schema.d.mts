export type VersionValidationResult = {
  valid: boolean;
  errors: string[];
  diagnostics: string[];
};

export function validateVersionStore(
  value: unknown,
  options?: { mode?: "read" | "write" },
): VersionValidationResult;

export function validateVersionSnapshot(value: unknown): VersionValidationResult;
