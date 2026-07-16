import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveLockedVersion } from "../src/versionDetect.js";
import { resolveCheckVersions } from "../src/checkResolve.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-check-latest-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

describe("resolveLockedVersion", () => {
  it("reads version from package-lock.json", () => {
    const dir = makeProject({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/axios": { version: "0.27.2" },
        },
      }),
    });
    expect(resolveLockedVersion(dir, "axios")).toBe("0.27.2");
    expect(resolveLockedVersion(dir, "missing")).toBeNull();
  });
});

describe("resolveCheckVersions --latest", () => {
  it("uses lockfile as from and mocked latest as to", async () => {
    const dir = makeProject({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/axios": { version: "0.27.2" },
        },
      }),
    });

    const result = await resolveCheckVersions("axios", {
      path: dir,
      latest: true,
      resolveLatest: async () => "1.7.9",
    });

    expect(result).toEqual({
      fromVersion: "0.27.2",
      toVersion: "1.7.9",
      upToDate: false,
    });
  });

  it("allows --from override with --latest", async () => {
    const result = await resolveCheckVersions("axios", {
      path: "/tmp",
      from: "0.26.0",
      latest: true,
      resolveLatest: async () => "1.7.9",
    });
    expect(result.fromVersion).toBe("0.26.0");
    expect(result.toVersion).toBe("1.7.9");
  });

  it("marks upToDate when locked === latest", async () => {
    const dir = makeProject({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/vite": { version: "8.1.0" },
        },
      }),
    });

    const result = await resolveCheckVersions("vite", {
      path: dir,
      latest: true,
      resolveLatest: async () => "8.1.0",
    });
    expect(result.upToDate).toBe(true);
  });

  it("rejects --latest with --to", async () => {
    await expect(
      resolveCheckVersions("axios", {
        path: ".",
        latest: true,
        to: "1.0.0",
        resolveLatest: async () => "1.0.0",
      }),
    ).rejects.toThrow(/not both/);
  });

  it("requires --to or --latest", async () => {
    await expect(
      resolveCheckVersions("axios", { path: "." }),
    ).rejects.toThrow(/--latest/);
  });

  it("still supports explicit --from and --to", async () => {
    const result = await resolveCheckVersions("axios", {
      path: ".",
      from: "0.27.2",
      to: "1.7.9",
    });
    expect(result).toEqual({
      fromVersion: "0.27.2",
      toVersion: "1.7.9",
      upToDate: false,
    });
  });
});
