import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { scanPackageUsage } from "../src/usageScanner.js";

const tempDirs: string[] = [];

function makeFixtureProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-usage-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanPackageUsage", () => {
  it("finds named import usages", () => {
    const dir = makeFixtureProject({
      "src/a.ts": `
import { merge, get } from "lodash";

export function run() {
  return merge({}, get({ a: 1 }, "a"));
}
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage.merge).toBeDefined();
    expect(usage.get).toBeDefined();
    expect(usage.merge[0].filePath).toBe("src/a.ts");
    expect(usage.merge[0].line).toBeGreaterThan(1);
  });

  it("finds namespace import usages", () => {
    const dir = makeFixtureProject({
      "src/ns.ts": `
import * as _ from "lodash";

export const x = _.map([1, 2], (n) => n * 2);
export const y = _.pick({ a: 1 }, ["a"]);
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(Object.keys(usage).sort()).toEqual(["map", "pick"]);
  });

  it("finds default import property usages", () => {
    const dir = makeFixtureProject({
      "src/def.ts": `
import lodash from "lodash";

export const z = lodash.trim("  hi  ");
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage.trim).toBeDefined();
    expect(usage.trim[0].filePath).toBe("src/def.ts");
  });

  it("finds require destructuring usages", () => {
    const dir = makeFixtureProject({
      "src/cjs.js": `
const { merge, get } = require("lodash");

function run() {
  return merge({}, get({ a: 1 }, "a"));
}

module.exports = { run };
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage.merge).toBeDefined();
    expect(usage.get).toBeDefined();
  });

  it("finds require namespace usages", () => {
    const dir = makeFixtureProject({
      "src/cjs2.js": `
const _ = require("lodash");

module.exports = _.cloneDeep({ a: 1 });
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage.cloneDeep).toBeDefined();
  });

  it("ignores imports of other packages", () => {
    const dir = makeFixtureProject({
      "src/other.ts": `
import { merge } from "some-other-lib";
export const x = merge({}, {});
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage).toEqual({});
  });

  it("handles aliased named imports", () => {
    const dir = makeFixtureProject({
      "src/alias.ts": `
import { merge as deepMerge } from "lodash";
export const out = deepMerge({ a: 1 }, { b: 2 });
`,
    });

    const usage = scanPackageUsage(dir, "lodash");
    expect(usage.merge).toBeDefined();
    expect(usage.deepMerge).toBeUndefined();
  });

  it("tracks named imports used as namespaces", () => {
    const dir = makeFixtureProject({
      "src/zodish.ts": `
import { z } from "zod";

export const schema = z.object({ name: z.string() });
`,
    });

    const usage = scanPackageUsage(dir, "zod");
    expect(usage.z).toBeDefined();
    expect(usage.z.length).toBeGreaterThanOrEqual(1);
  });
});
