import fs from "node:fs";
import path from "node:path";
import type { VersionBump } from "./types.js";

/**
 * Detect dependency version bumps from lockfiles and/or package.json.
 * Supports npm package-lock.json (v2/v3), pnpm-lock.yaml (simple parse),
 * and yarn.lock (basic).
 */
export function detectVersionBumps(
  projectDir: string,
  options: { packageName?: string } = {},
): VersionBump[] {
  const abs = path.resolve(projectDir);
  const bumps: VersionBump[] = [];

  const npmLock = path.join(abs, "package-lock.json");
  if (fs.existsSync(npmLock)) {
    bumps.push(...detectFromNpmLock(npmLock, options.packageName));
  }

  const pnpmLock = path.join(abs, "pnpm-lock.yaml");
  if (fs.existsSync(pnpmLock) && bumps.length === 0) {
    bumps.push(...detectFromPnpmLock(pnpmLock, options.packageName));
  }

  const yarnLock = path.join(abs, "yarn.lock");
  if (fs.existsSync(yarnLock) && bumps.length === 0) {
    bumps.push(...detectFromYarnLock(yarnLock, options.packageName));
  }

  // Also compare package.json declared ranges against lock when a single package is requested
  // and no lock bump was found — fall back to package.json version if it's a pinned version.
  if (options.packageName && bumps.length === 0) {
    const pinned = readPinnedFromPackageJson(abs, options.packageName);
    if (pinned) bumps.push(pinned);
  }

  return bumps;
}

/**
 * Read the currently locked version of a package from the project's lockfile.
 */
export function resolveLockedVersion(
  projectDir: string,
  packageName: string,
): string | null {
  const bumps = detectVersionBumps(projectDir, { packageName });
  const match = bumps.find((b) => b.packageName === packageName);
  return match?.toVersion ?? null;
}

/**
 * Resolve --from/--to for a package: use explicit overrides, else lockfile detection.
 */
export function resolveFromTo(
  projectDir: string,
  packageName: string,
  from?: string,
  to?: string,
): { fromVersion: string; toVersion: string } {
  if (from && to) return { fromVersion: from, toVersion: to };

  const locked = resolveLockedVersion(projectDir, packageName);
  if (!locked) {
    throw new Error(
      `Could not auto-detect versions for "${packageName}". `
        + `Pass --from and --to explicitly, or ensure a lockfile lists the package.`,
    );
  }

  return {
    fromVersion: from ?? locked,
    toVersion: to ?? locked,
  };
}

function detectFromNpmLock(lockPath: string, packageName?: string): VersionBump[] {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };

    const bumps: VersionBump[] = [];

    // package-lock v2/v3: packages[\"node_modules/foo\"]
    if (lock.packages) {
      for (const [key, meta] of Object.entries(lock.packages)) {
        if (!meta.version) continue;
        const name = key.replace(/^node_modules\//, "");
        if (!name || name.includes("node_modules/")) continue;
        if (packageName && name !== packageName) continue;
        // Without a before/after lock we can only report current pinned version as both ends.
        // Callers doing PR diffs should pass two lockfiles; for CLI autodetection we expose
        // the lock version as `to` and leave `from` same unless packages differs — see below.
        bumps.push({
          packageName: name,
          fromVersion: meta.version,
          toVersion: meta.version,
        });
      }
    }

    return packageName
      ? bumps.filter((b) => b.packageName === packageName)
      : bumps;
  } catch {
    return [];
  }
}

/**
 * Compare two package-lock.json contents and return version bumps.
 * Used by the GitHub Action with base/head lockfiles.
 */
export function diffNpmLockfiles(
  baseLockJson: string,
  headLockJson: string,
  packageName?: string,
): VersionBump[] {
  const baseVersions = readNpmLockVersions(baseLockJson);
  const headVersions = readNpmLockVersions(headLockJson);
  const names = new Set([...baseVersions.keys(), ...headVersions.keys()]);
  const bumps: VersionBump[] = [];

  for (const name of names) {
    if (packageName && name !== packageName) continue;
    const fromVersion = baseVersions.get(name);
    const toVersion = headVersions.get(name);
    if (!fromVersion || !toVersion) continue;
    if (fromVersion === toVersion) continue;
    bumps.push({ packageName: name, fromVersion, toVersion });
  }

  return bumps;
}

/**
 * Parse top-level package versions from package-lock.json (v2/v3) text.
 * Invalid JSON returns an empty map (lenient). Prefer parseNpmLockVersionsOrThrow for strict mode.
 */
export function readNpmLockVersions(lockJson: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const lock = JSON.parse(lockJson) as {
      packages?: Record<string, { version?: string }>;
    };
    for (const [key, meta] of Object.entries(lock.packages ?? {})) {
      if (!meta.version) continue;
      if (!key.startsWith("node_modules/")) continue;
      const rest = key.slice("node_modules/".length);
      if (rest.includes("node_modules/")) continue;
      map.set(rest, meta.version);
    }
  } catch {
    // ignore
  }
  return map;
}

/**
 * Strict npm lock parse — throws a clear error on invalid JSON.
 */
export function parseNpmLockVersionsOrThrow(
  lockJson: string,
  fileLabel = "package-lock.json",
): Map<string, string> {
  if (!lockJson.trim()) {
    throw new Error(
      `${fileLabel} is empty.\n`
        + `Regenerate it with: npm install`,
    );
  }
  try {
    JSON.parse(lockJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${fileLabel} is not valid JSON (${msg}).\n`
        + `Fix or regenerate the lockfile with: npm install`,
    );
  }
  return readNpmLockVersions(lockJson);
}

function detectFromPnpmLock(lockPath: string, packageName?: string): VersionBump[] {
  const map = readPnpmLockVersions(fs.readFileSync(lockPath, "utf8"));
  const bumps: VersionBump[] = [];
  for (const [name, version] of map) {
    if (packageName && name !== packageName) continue;
    bumps.push({ packageName: name, fromVersion: version, toVersion: version });
  }
  return packageName ? bumps.filter((b) => b.packageName === packageName) : bumps;
}

/**
 * Parse package versions from pnpm-lock.yaml.
 *
 * Supported key styles (packages: section):
 * - `/lodash@4.17.21:`
 * - `/@scope/name@1.2.3:`
 * - `/lodash@4.17.21(peer@1.0.0):` → version `4.17.21`
 *
 * Documented support: lockfileVersion 5.x–10.x style `packages:` keys (common v7–v10 layouts).
 * Empty content or packages with no resolvable entries throws via parsePnpmLockVersionsOrThrow.
 */
export function readPnpmLockVersions(lockText: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match `/name@version` or `/@scope/name@version` optionally followed by (peers) then :
  const re = /^\s{2}\/(@?[^@\s/]+(?:\/[^@\s]+)?)@([^:(]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lockText))) {
    const name = m[1];
    const version = m[2];
    if (!map.has(name)) map.set(name, version);
  }
  return map;
}

/**
 * Strict pnpm lock parse.
 */
export function parsePnpmLockVersionsOrThrow(
  lockText: string,
  fileLabel = "pnpm-lock.yaml",
): Map<string, string> {
  if (!lockText.trim()) {
    throw new Error(
      `${fileLabel} is empty.\n`
        + `Regenerate it with: pnpm install`,
    );
  }
  if (!/packages\s*:/.test(lockText) && !/importers\s*:/.test(lockText)) {
    throw new Error(
      `${fileLabel} does not look like a pnpm lockfile (missing packages:/importers:).\n`
        + `Regenerate it with: pnpm install`,
    );
  }
  const map = readPnpmLockVersions(lockText);
  if (map.size === 0) {
    throw new Error(
      `${fileLabel} has no resolvable package entries under packages:.\n`
        + `Regenerate it with: pnpm install`,
    );
  }
  return map;
}

/**
 * Diff two lockfile texts of the same kind into version bumps.
 */
export function diffLockfileVersions(
  kind: "npm" | "pnpm" | "yarn",
  baseText: string,
  headText: string,
  packageName?: string,
): VersionBump[] {
  if (kind === "yarn") {
    throw new Error(
      "Yarn lockfile PR diffs are not supported yet.\n"
        + "Use package-lock.json or pnpm-lock.yaml.",
    );
  }
  const baseVersions =
    kind === "pnpm"
      ? parsePnpmLockVersionsOrThrow(baseText, "base pnpm-lock.yaml")
      : parseNpmLockVersionsOrThrow(baseText, "base package-lock.json");
  const headVersions =
    kind === "pnpm"
      ? parsePnpmLockVersionsOrThrow(headText, "head pnpm-lock.yaml")
      : parseNpmLockVersionsOrThrow(headText, "head package-lock.json");

  const names = new Set([...baseVersions.keys(), ...headVersions.keys()]);
  const bumps: VersionBump[] = [];
  for (const name of names) {
    if (packageName && name !== packageName) continue;
    const fromVersion = baseVersions.get(name);
    const toVersion = headVersions.get(name);
    if (!fromVersion || !toVersion) continue;
    if (fromVersion === toVersion) continue;
    bumps.push({ packageName: name, fromVersion, toVersion });
  }
  return bumps;
}

function detectFromYarnLock(lockPath: string, packageName?: string): VersionBump[] {
  // yarn classic: "lodash@^4.17.21:\n  version \"4.17.21\""
  const text = fs.readFileSync(lockPath, "utf8");
  const bumps: VersionBump[] = [];
  const blockRe = /(?:^|\n)("[^"]+"|[^:\n]+):\n\s+version\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const key = m[1].replace(/^"|"$/g, "");
    const version = m[2];
    const name = key.replace(/@[\^~>=<\d].*$/, "").replace(/__tmp.*/, "");
    // Scoped: "@scope/name@^1.0.0"
    let pkg = name;
    if (key.startsWith("@")) {
      const parts = key.split("@");
      // ["", "scope/name", "^1.0.0"] or ["", "scope/name", "1.0.0"]
      pkg = `@${parts[1]}`;
    } else {
      pkg = key.split("@")[0];
    }
    if (packageName && pkg !== packageName) continue;
    bumps.push({ packageName: pkg, fromVersion: version, toVersion: version });
  }
  return packageName ? bumps.filter((b) => b.packageName === packageName) : bumps;
}

function readPinnedFromPackageJson(
  projectDir: string,
  packageName: string,
): VersionBump | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range =
      pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName];
    if (!range) return null;
    if (/^\d+\.\d+\.\d+/.test(range)) {
      return { packageName, fromVersion: range, toVersion: range };
    }
  } catch {
    // ignore
  }
  return null;
}
