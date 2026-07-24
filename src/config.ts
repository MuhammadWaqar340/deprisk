import fs from "node:fs";
import path from "node:path";
import { normalizeFailOn, type FailOn } from "./exitCode.js";

export interface DepRiskConfig {
  failOn?: FailOn;
  includeDev?: boolean;
  followReexports?: boolean;
  workspaces?: boolean;
  semverWeight?: boolean;
  showUpToDate?: boolean;
  includeSkipped?: boolean;
  all?: boolean;
  concurrency?: number;
  /** Expand deep compatibility details in human/Markdown output */
  deep?: boolean;
}

const CONFIG_NAMES = [".depriskrc.json", ".depriskrc"] as const;

/**
 * Load `.depriskrc.json` or `.depriskrc` from a project directory.
 * Returns `{}` when missing. Throws on invalid JSON or invalid values.
 */
export function loadDepRiskConfig(projectDir: string): DepRiskConfig {
  const abs = path.resolve(projectDir);
  for (const name of CONFIG_NAMES) {
    const filePath = path.join(abs, name);
    if (!fs.existsSync(filePath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid ${name}: could not parse JSON (${msg}). `
          + `Fix the file or remove it.`,
      );
    }
    return validateDepRiskConfig(raw, name);
  }
  return {};
}

export function validateDepRiskConfig(raw: unknown, source = ".depriskrc"): DepRiskConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    "failOn",
    "includeDev",
    "followReexports",
    "workspaces",
    "semverWeight",
    "showUpToDate",
    "includeSkipped",
    "all",
    "concurrency",
    "deep",
  ]);

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unknown option "${key}" in ${source}. `
          + `Allowed: ${[...allowed].join(", ")}.`,
      );
    }
  }

  const config: DepRiskConfig = {};

  if (obj.failOn !== undefined) {
    if (typeof obj.failOn !== "string") {
      throw new Error(`${source}: "failOn" must be a string.`);
    }
    config.failOn = normalizeFailOn(obj.failOn);
  }
  for (const boolKey of [
    "includeDev",
    "followReexports",
    "workspaces",
    "semverWeight",
    "showUpToDate",
    "includeSkipped",
    "all",
    "deep",
  ] as const) {
    if (obj[boolKey] !== undefined) {
      if (typeof obj[boolKey] !== "boolean") {
        throw new Error(`${source}: "${boolKey}" must be a boolean.`);
      }
      config[boolKey] = obj[boolKey] as boolean;
    }
  }
  if (obj.concurrency !== undefined) {
    if (typeof obj.concurrency !== "number" || !Number.isInteger(obj.concurrency) || obj.concurrency < 1) {
      throw new Error(`${source}: "concurrency" must be a positive integer.`);
    }
    config.concurrency = obj.concurrency;
  }

  return config;
}

/**
 * Merge CLI overrides over config over defaults.
 * Only keys present in `cli` (not undefined) win.
 */
export function mergeConfig<T extends Record<string, unknown>>(
  defaults: T,
  fileConfig: Partial<T>,
  cli: Partial<T>,
): T {
  return {
    ...defaults,
    ...stripUndefined(fileConfig),
    ...stripUndefined(cli),
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
