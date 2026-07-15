import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pacote from "pacote";
import type { FetchResult } from "./types.js";

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".deprisk", "cache");

export interface FetchVersionsOptions {
  cacheDir?: string;
}

/**
 * Download two package versions from the npm registry, extract them,
 * and locate each version's TypeScript entry (.d.ts).
 */
export async function fetchPackageVersions(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  options: FetchVersionsOptions = {},
): Promise<FetchResult> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });

  const [oldRoot, newRoot] = await Promise.all([
    extractVersion(packageName, fromVersion, cacheDir),
    extractVersion(packageName, toVersion, cacheDir),
  ]);

  const oldTypes = resolveTypesEntry(oldRoot);
  const newTypes = resolveTypesEntry(newRoot);

  if (!oldTypes || !newTypes) {
    const missing: string[] = [];
    if (!oldTypes) missing.push(fromVersion);
    if (!newTypes) missing.push(toVersion);
    return {
      kind: "untyped",
      packageName,
      message: `Package "${packageName}" has no TypeScript types available for version(s): ${missing.join(", ")}. DepRisk v1 only analyzes packages that ship .d.ts files.`,
    };
  }

  return {
    kind: "typed",
    oldRoot,
    newRoot,
    oldTypesEntry: oldTypes,
    newTypesEntry: newTypes,
  };
}

async function extractVersion(
  packageName: string,
  version: string,
  cacheDir: string,
): Promise<string> {
  const safeName = packageName.replace("/", "__");
  const dest = path.join(cacheDir, `${safeName}@${version}`);

  // Reuse extracted tree when present
  if (fs.existsSync(path.join(dest, "package.json"))) {
    return dest;
  }

  fs.mkdirSync(dest, { recursive: true });
  try {
    await pacote.extract(`${packageName}@${version}`, dest, {
      cache: path.join(cacheDir, "_pacote"),
    });
  } catch (err) {
    // Clean partial extract
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
    // Distinguish package vs version: if the base package exists this is a version miss.
    if (/version/i.test(message) || message.includes(`@${version}`)) {
      return new Error(`Version not found: ${packageName}@${version}`);
    }
    return new Error(`Package not found: ${packageName} (version ${version})`);
  }

  return new Error(`Failed to fetch ${packageName}@${version}: ${message}`);
}

/**
 * Resolve the types entry path for an extracted package root.
 * Checks package.json "types" / "typings", then common fallbacks.
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

  // Nested package.json "exports" types field (common in modern packages)
  const exportTypes = collectExportTypes(pkg.exports);
  candidates.push(...exportTypes);

  candidates.push("index.d.ts", "dist/index.d.ts", "lib/index.d.ts", "types/index.d.ts");

  for (const rel of candidates) {
    const abs = path.resolve(packageRoot, rel);
    if (fs.existsSync(abs) && abs.endsWith(".d.ts")) {
      return abs;
    }
    // Sometimes "types" points to a .ts-less path like "dist/index" — try .d.ts
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
    // Conditional exports: { "import": { "types": "..." }, "types": "..." }
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
};
