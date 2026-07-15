import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pacote from "pacote";
import type { FetchResult, TypesSource } from "./types.js";

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".deprisk", "cache");

export interface FetchVersionsOptions {
  cacheDir?: string;
  /** Injectable for unit tests — resolves which @types version to use */
  resolveTypesPackageVersion?: (
    typesPackage: string,
    targetVersion: string,
  ) => Promise<string | null>;
}

/**
 * Download two package versions from the npm registry, extract them,
 * and locate each version's TypeScript entry (.d.ts).
 * Falls back to DefinitelyTyped (`@types/*`) when the package ships no types.
 */
export async function fetchPackageVersions(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  options: FetchVersionsOptions = {},
): Promise<FetchResult> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });

  const [oldResolved, newResolved] = await Promise.all([
    resolveTypedRoot(packageName, fromVersion, cacheDir, options),
    resolveTypedRoot(packageName, toVersion, cacheDir, options),
  ]);

  if (!oldResolved || !newResolved) {
    const missing: string[] = [];
    if (!oldResolved) missing.push(fromVersion);
    if (!newResolved) missing.push(toVersion);
    const typesPkg = toDefinitelyTypedName(packageName);
    return {
      kind: "untyped",
      packageName,
      message:
        `Package "${packageName}" has no TypeScript types available for version(s): ${missing.join(", ")}. `
        + `Checked bundled .d.ts and DefinitelyTyped package "${typesPkg}".`,
    };
  }

  return {
    kind: "typed",
    oldRoot: oldResolved.root,
    newRoot: newResolved.root,
    oldTypesEntry: oldResolved.typesEntry,
    newTypesEntry: newResolved.typesEntry,
    typesSource: {
      old: oldResolved.source,
      new: newResolved.source,
    },
  };
}

interface ResolvedTypedRoot {
  root: string;
  typesEntry: string;
  source: TypesSource;
}

async function resolveTypedRoot(
  packageName: string,
  version: string,
  cacheDir: string,
  options: FetchVersionsOptions,
): Promise<ResolvedTypedRoot | null> {
  const root = await extractVersion(packageName, version, cacheDir);
  const bundled = resolveTypesEntry(root);
  if (bundled) {
    return { root, typesEntry: bundled, source: "bundled" };
  }

  const typesPackage = toDefinitelyTypedName(packageName);
  const resolveVer =
    options.resolveTypesPackageVersion ?? defaultResolveTypesPackageVersion;

  const typesVersion = await resolveVer(typesPackage, version);
  if (!typesVersion) return null;

  try {
    const typesRoot = await extractVersion(typesPackage, typesVersion, cacheDir);
    const typesEntry = resolveTypesEntry(typesRoot);
    if (!typesEntry) return null;
    return { root: typesRoot, typesEntry, source: "definitelyTyped" };
  } catch {
    return null;
  }
}

/**
 * Map an npm package name to its DefinitelyTyped package.
 * `@scope/name` → `@types/scope__name`
 */
export function toDefinitelyTypedName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const withoutAt = packageName.slice(1);
    const slash = withoutAt.indexOf("/");
    if (slash === -1) return `@types/${withoutAt}`;
    const scope = withoutAt.slice(0, slash);
    const name = withoutAt.slice(slash + 1);
    return `@types/${scope}__${name}`;
  }
  return `@types/${packageName}`;
}

/**
 * Heuristic for picking an `@types` version for a given runtime package version:
 * 1. Exact version match if published
 * 2. Highest version sharing the same major
 * 3. Latest available `@types` version
 */
export async function defaultResolveTypesPackageVersion(
  typesPackage: string,
  targetVersion: string,
): Promise<string | null> {
  try {
    const packument = await pacote.packument(typesPackage, {
      fullMetadata: false,
    });
    const versions = Object.keys(packument.versions ?? {}).filter(
      (v) => !v.includes("-"),
    );
    if (versions.length === 0) return null;

    if (versions.includes(targetVersion)) return targetVersion;

    const targetMajor = majorOf(targetVersion);
    const sameMajor = versions
      .filter((v) => majorOf(v) === targetMajor)
      .sort(compareSemverDesc);
    if (sameMajor.length > 0) return sameMajor[0];

    return versions.sort(compareSemverDesc)[0] ?? null;
  } catch {
    return null;
  }
}

function majorOf(version: string): number {
  const n = Number.parseInt(version.split(".")[0] ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function extractVersion(
  packageName: string,
  version: string,
  cacheDir: string,
): Promise<string> {
  const safeName = packageName.replace("/", "__");
  const dest = path.join(cacheDir, `${safeName}@${version}`);

  if (fs.existsSync(path.join(dest, "package.json"))) {
    return dest;
  }

  fs.mkdirSync(dest, { recursive: true });
  try {
    await pacote.extract(`${packageName}@${version}`, dest, {
      cache: path.join(cacheDir, "_pacote"),
    });
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw normalizeFetchError(packageName, version, err);
  }

  return dest;
}

function normalizeFetchError(packageName: string, version: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { statusCode?: number; code?: string }).statusCode
    ?? (err as { code?: string }).code;

  if (
    status === 404
    || message.includes("E404")
    || /not found/i.test(message)
    || /No matching version/i.test(message)
  ) {
    if (/version/i.test(message) || message.includes(`@${version}`)) {
      return new Error(`Version not found: ${packageName}@${version}`);
    }
    return new Error(`Package not found: ${packageName} (version ${version})`);
  }

  return new Error(`Failed to fetch ${packageName}@${version}: ${message}`);
}

/**
 * Resolve the types entry path for an extracted package root.
 */
export function resolveTypesEntry(packageRoot: string): string | null {
  const pkgJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;

  let pkg: {
    types?: string;
    typings?: string;
    exports?: unknown;
  };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as typeof pkg;
  } catch {
    return null;
  }

  const candidates: string[] = [];

  if (typeof pkg.types === "string") candidates.push(pkg.types);
  if (typeof pkg.typings === "string") candidates.push(pkg.typings);

  candidates.push(...collectExportTypes(pkg.exports));
  candidates.push("index.d.ts", "dist/index.d.ts", "lib/index.d.ts", "types/index.d.ts");

  for (const rel of candidates) {
    const abs = path.resolve(packageRoot, rel);
    if (fs.existsSync(abs) && abs.endsWith(".d.ts")) {
      return abs;
    }
    if (!rel.endsWith(".d.ts")) {
      const withDts = path.resolve(packageRoot, `${rel}.d.ts`);
      if (fs.existsSync(withDts)) return withDts;
    }
  }

  return null;
}

function collectExportTypes(exportsField: unknown): string[] {
  const found: string[] = [];
  if (!exportsField) return found;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.types === "string") found.push(obj.types);
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") visit(value);
    }
  };

  visit(exportsField);
  return found;
}

/** @internal exposed for unit tests */
export const __test__ = {
  resolveTypesEntry,
  normalizeFetchError,
  DEFAULT_CACHE_DIR,
  compareSemverDesc,
  majorOf,
};
