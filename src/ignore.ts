import fs from "node:fs";
import path from "node:path";

/**
 * Load `.depriskignore` — one export name or `package:export` per line.
 * Lines starting with `#` are comments.
 */
export function loadIgnoreSet(
  projectDir: string,
  packageName: string,
): Set<string> {
  const ignore = new Set<string>();
  const filePath = path.join(path.resolve(projectDir), ".depriskignore");
  if (!fs.existsSync(filePath)) return ignore;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.includes(":")) {
      const [pkg, exp] = line.split(":");
      if (pkg === packageName && exp) ignore.add(exp);
    } else {
      ignore.add(line);
    }
  }

  return ignore;
}

/** Remove ignored export names from a usage map (in place) and return filtered copy of diff flags later via filter. */
export function filterIgnoredNames<T extends { name: string }>(
  entries: T[],
  ignore: Set<string>,
): T[] {
  if (ignore.size === 0) return entries;
  return entries.filter((e) => !ignore.has(e.name));
}
