import pacote from "pacote";

/**
 * Resolve the latest stable (non-prerelease) version of a package on npm.
 * Prefers the `latest` dist-tag when it is stable; otherwise the highest
 * semver version without a prerelease suffix.
 */
export async function resolveLatestVersion(
  packageName: string,
  options: {
    /** Injectable for unit tests */
    fetchPackument?: (name: string) => Promise<{
      "dist-tags"?: Record<string, string>;
      versions?: Record<string, unknown>;
    }>;
  } = {},
): Promise<string> {
  const fetchPackument = options.fetchPackument ?? defaultFetchPackument;
  const packument = await fetchPackument(packageName);
  const versions = Object.keys(packument.versions ?? {});
  if (versions.length === 0) {
    throw new Error(`No versions found for package "${packageName}"`);
  }

  const latestTag = packument["dist-tags"]?.latest;
  if (latestTag && isStableVersion(latestTag) && versions.includes(latestTag)) {
    return latestTag;
  }

  const stable = versions.filter(isStableVersion).sort(compareSemverDesc);
  if (stable.length > 0) return stable[0];

  // Fall back to dist-tags.latest even if prerelease, else highest version
  if (latestTag) return latestTag;
  return versions.sort(compareSemverDesc)[0];
}

async function defaultFetchPackument(packageName: string): Promise<{
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, unknown>;
}> {
  return pacote.packument(packageName, { fullMetadata: false });
}

export function isStableVersion(version: string): boolean {
  // 1.2.3 ok; 1.2.3-beta.1 not
  return /^\d+\.\d+\.\d+$/.test(version);
}

export function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
