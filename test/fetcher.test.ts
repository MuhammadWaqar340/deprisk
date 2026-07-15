import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveTypesEntry } from "../src/fetcher.js";

const tempDirs: string[] = [];

function makeTempPkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-fetcher-"));
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

describe("resolveTypesEntry", () => {
  it("reads the types field from package.json", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({ name: "x", types: "lib/x.d.ts" }),
      "lib/x.d.ts": "export declare const x: number;",
    });
    expect(resolveTypesEntry(root)).toBe(path.join(root, "lib/x.d.ts"));
  });

  it("falls back to index.d.ts when types is missing", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({ name: "x" }),
      "index.d.ts": "export declare const x: number;",
    });
    expect(resolveTypesEntry(root)).toBe(path.join(root, "index.d.ts"));
  });

  it("falls back to dist/index.d.ts", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({ name: "x" }),
      "dist/index.d.ts": "export declare const x: number;",
    });
    expect(resolveTypesEntry(root)).toBe(path.join(root, "dist/index.d.ts"));
  });

  it("resolves exports.types conditional", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({
        name: "x",
        exports: { ".": { types: "./dist/main.d.ts", default: "./dist/main.js" } },
      }),
      "dist/main.d.ts": "export declare const x: number;",
    });
    expect(resolveTypesEntry(root)).toBe(path.join(root, "dist/main.d.ts"));
  });

  it("returns null for untyped packages", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({ name: "x", main: "index.js" }),
      "index.js": "module.exports = {};",
    });
    expect(resolveTypesEntry(root)).toBeNull();
  });

  it("appends .d.ts when types points to a bare path", () => {
    const root = makeTempPkg({
      "package.json": JSON.stringify({ name: "x", types: "dist/index" }),
      "dist/index.d.ts": "export declare const x: number;",
    });
    expect(resolveTypesEntry(root)).toBe(path.join(root, "dist/index.d.ts"));
  });
});
