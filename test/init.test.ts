import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { generateWorkflowYaml, initGitHubWorkflow } from "../src/init.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateWorkflowYaml", () => {
  it("includes DepRisk job and fail-on setting", () => {
    const yaml = generateWorkflowYaml({ failOn: "medium", packageVersion: "0.7.0" });
    expect(yaml).toContain("name: DepRisk");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("deprisk-check@0.7.0");
    expect(yaml).toContain("--fail-on medium");
    expect(yaml).toContain("deprisk scan");
  });
});

describe("initGitHubWorkflow", () => {
  it("creates .github/workflows/deprisk.yml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-init-"));
    tempDirs.push(dir);

    const result = initGitHubWorkflow({ path: dir });
    expect(result.written).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath, "utf8")).toContain("name: DepRisk");
  });

  it("skips when file exists unless --force", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-init-"));
    tempDirs.push(dir);

    initGitHubWorkflow({ path: dir });
    const second = initGitHubWorkflow({ path: dir });
    expect(second.skipped).toBe(true);
    expect(second.written).toBe(false);

    const forced = initGitHubWorkflow({ path: dir, force: true, failOn: "medium" });
    expect(forced.written).toBe(true);
    expect(fs.readFileSync(forced.filePath, "utf8")).toContain("--fail-on medium");
  });
});
