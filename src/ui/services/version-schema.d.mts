export type ValidationResult = { valid: boolean; errors: string[] };
export function validateVersionStore(value: unknown, options?: { mode?: "read" | "write" }): ValidationResult;
export function validateVersionSnapshot(value: unknown): ValidationResult;
