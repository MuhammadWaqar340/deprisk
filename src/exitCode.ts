import type { RiskLevel } from "./types.js";

export type FailOn = "high" | "medium" | "error";

export const FAIL_ON_VALUES: FailOn[] = ["high", "medium", "error"];

/**
 * Normalize and validate a --fail-on value. Returns undefined when not set.
 * Throws on an unrecognized value.
 */
export function normalizeFailOn(value?: string): FailOn | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if ((FAIL_ON_VALUES as string[]).includes(lower)) {
    return lower as FailOn;
  }
  throw new Error(
    `Invalid --fail-on value "${value}". Use one of: ${FAIL_ON_VALUES.join(", ")}.`,
  );
}

/**
 * Compute the process exit code from the worst risk level, the --fail-on gate,
 * and whether any packages failed to analyze (errors).
 *
 * - HIGH always maps to 2 (when gated or by default), MEDIUM to 1.
 * - `--fail-on high`   → fail only on HIGH; errors are ignored.
 * - `--fail-on medium` → fail on HIGH/MEDIUM; errors are ignored.
 * - `--fail-on error`  → fail on HIGH/MEDIUM and on any analysis error.
 * - No gate (default)  → HIGH=2, MEDIUM=1, LOW=0; errors ignored here
 *                        (callers may treat an all-errors scan as a soft failure).
 */
export function computeExitCode(
  level: RiskLevel,
  failOn?: FailOn,
  hasErrors = false,
): number {
  const riskCode = level === "HIGH" ? 2 : level === "MEDIUM" ? 1 : 0;

  switch (failOn) {
    case "high":
      return level === "HIGH" ? 2 : 0;
    case "medium":
      return riskCode;
    case "error":
      return Math.max(riskCode, hasErrors ? 1 : 0);
    default:
      return riskCode;
  }
}
