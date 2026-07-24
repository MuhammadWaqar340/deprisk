import fs from "node:fs";
import path from "node:path";

export type LockfileKind = "npm" | "pnpm" | "yarn";

export interface LockfileInfo {
  kind: LockfileKind;
  fileName: string;
  absolutePath: string;
}

export interface DetectedLockfiles {
  found: LockfileInfo[];
  /** Primary lockfile chosen for analysis */
  primary: LockfileInfo | null;
  /** Warning when multiple lockfiles exist */
  warning: string | null;
}

const CANDIDATES: { kind: LockfileKind; fileName: string }[] = [
  { kind: "npm", fileName: "package-lock.json" },
  { kind: "pnpm", fileName: "pnpm-lock.yaml" },
  { kind: "yarn", fileName: "yarn.lock" },
];

/**
 * Detect lockfiles in a project directory.
 *
 * Priority when multiple exist: pnpm > npm > yarn
 * (prefer the lockfile that most modern monorepos actually use when both npm and pnpm are present).
 */
export function detectLockfiles(projectDir: string): DetectedLockfiles {
  const abs = path.resolve(projectDir);
  const found: LockfileInfo[] = [];

  for (const c of CANDIDATES) {
    const absolutePath = path.join(abs, c.fileName);
    if (fs.existsSync(absolutePath)) {
      found.push({ kind: c.kind, fileName: c.fileName, absolutePath });
    }
  }

  if (found.length === 0) {
    return { found, primary: null, warning: null };
  }

  const priority: LockfileKind[] = ["pnpm", "npm", "yarn"];
  const primary =
    priority
      .map((k) => found.find((f) => f.kind === k))
      .find((x): x is LockfileInfo => Boolean(x))
    ?? found[0];

  let warning: string | null = null;
  if (found.length > 1) {
    warning =
      `Multiple lockfiles detected:\n`
      + found.map((f) => `  - ${f.fileName}`).join("\n")
      + `\nUsing: ${primary.fileName}`;
  }

  return { found, primary, warning };
}

/**
 * Assert a primary lockfile exists or throw a clear error for --latest.
 */
export function requireLockfileForLatest(projectDir: string): DetectedLockfiles {
  const detected = detectLockfiles(projectDir);
  if (!detected.primary) {
    throw new Error(
      `No lockfile found in ${path.resolve(projectDir)}.\n`
      + `DepRisk --latest needs one of:\n`
      + `  - package-lock.json (npm)\n`
      + `  - pnpm-lock.yaml (pnpm)\n`
      + `Yarn lockfiles are detected but not yet supported for --latest scan.\n`
      + `Generate a lockfile (npm install / pnpm install) and retry.`,
    );
  }
  if (detected.primary.kind === "yarn") {
    throw new Error(
      `Found yarn.lock but DepRisk scan --latest does not fully support Yarn yet.\n`
      + `Use package-lock.json or pnpm-lock.yaml, or run:\n`
      + `  deprisk check <package> --latest\n`
      + `which can still read a locked version from yarn.lock for a single package.`,
    );
  }
  return detected;
}

/**
 * Assert a lockfile suitable for PR bump mode (npm or pnpm).
 */
export function requireLockfileForPrMode(projectDir: string): DetectedLockfiles {
  const detected = detectLockfiles(projectDir);
  if (!detected.primary) {
    throw new Error(
      `No lockfile found in ${path.resolve(projectDir)}.\n`
      + `PR bump mode needs package-lock.json or pnpm-lock.yaml.\n`
      + `Pass --head-lock <file> or generate a lockfile.`,
    );
  }
  if (detected.primary.kind === "yarn") {
    throw new Error(
      `Found yarn.lock but DepRisk PR bump mode does not support Yarn yet.\n`
      + `Use package-lock.json or pnpm-lock.yaml for --base-lock/--base-ref scans.`,
    );
  }
  return detected;
}
