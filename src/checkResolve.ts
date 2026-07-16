import { resolveFromTo, resolveLockedVersion } from "./versionDetect.js";
import { resolveLatestVersion } from "./latest.js";

/**
 * Resolve from/to for `deprisk check`.
 * With `--latest`: locked (or `--from`) → npm latest.
 */
export async function resolveCheckVersions(
  packageName: string,
  opts: {
    path: string;
    from?: string;
    to?: string;
    latest?: boolean;
    resolveLatest?: (name: string) => Promise<string>;
  },
): Promise<{ fromVersion: string; toVersion: string; upToDate: boolean }> {
  if (opts.latest) {
    if (opts.to) {
      throw new Error("Use --latest or --to, not both.");
    }

    const fromVersion =
      opts.from
      ?? resolveLockedVersion(opts.path, packageName);

    if (!fromVersion) {
      throw new Error(
        `Could not find "${packageName}" in the lockfile. `
          + `Pass --from <version> --latest, or ensure package-lock.json lists the package.`,
      );
    }

    const resolveLatest = opts.resolveLatest ?? resolveLatestVersion;
    const toVersion = await resolveLatest(packageName);
    return {
      fromVersion,
      toVersion,
      upToDate: fromVersion === toVersion,
    };
  }

  if (!opts.to) {
    throw new Error(
      `Pass --to <version>, or use --latest to compare against npm latest `
        + `(e.g. deprisk check ${packageName} --latest).`,
    );
  }

  const { fromVersion, toVersion } = resolveFromTo(
    opts.path,
    packageName,
    opts.from,
    opts.to,
  );
  return { fromVersion, toVersion, upToDate: fromVersion === toVersion };
}
