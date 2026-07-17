import { describe, it, expect } from "vitest";
import {
  computeExitCode,
  normalizeFailOn,
  FAIL_ON_VALUES,
} from "../src/exitCode.js";

describe("normalizeFailOn", () => {
  it("returns undefined when not set", () => {
    expect(normalizeFailOn(undefined)).toBeUndefined();
  });

  it("lowercases and accepts valid values", () => {
    expect(normalizeFailOn("high")).toBe("high");
    expect(normalizeFailOn("MEDIUM")).toBe("medium");
    expect(normalizeFailOn("Error")).toBe("error");
  });

  it("exposes the full set of values", () => {
    expect(FAIL_ON_VALUES).toEqual(["high", "medium", "error"]);
  });

  it("throws on an unknown value", () => {
    expect(() => normalizeFailOn("critical")).toThrow(/Invalid --fail-on/);
  });
});

describe("computeExitCode", () => {
  it("default gate: HIGH=2, MEDIUM=1, LOW=0", () => {
    expect(computeExitCode("HIGH")).toBe(2);
    expect(computeExitCode("MEDIUM")).toBe(1);
    expect(computeExitCode("LOW")).toBe(0);
  });

  it("--fail-on high only fails on HIGH", () => {
    expect(computeExitCode("HIGH", "high")).toBe(2);
    expect(computeExitCode("MEDIUM", "high")).toBe(0);
    expect(computeExitCode("LOW", "high")).toBe(0);
  });

  it("--fail-on medium fails on HIGH/MEDIUM", () => {
    expect(computeExitCode("HIGH", "medium")).toBe(2);
    expect(computeExitCode("MEDIUM", "medium")).toBe(1);
    expect(computeExitCode("LOW", "medium")).toBe(0);
  });

  it("high/medium ignore analysis errors", () => {
    expect(computeExitCode("LOW", "high", true)).toBe(0);
    expect(computeExitCode("LOW", "medium", true)).toBe(0);
  });

  it("--fail-on error fails on any analysis error", () => {
    expect(computeExitCode("LOW", "error", true)).toBe(1);
    expect(computeExitCode("LOW", "error", false)).toBe(0);
  });

  it("--fail-on error still escalates HIGH to 2", () => {
    expect(computeExitCode("HIGH", "error", true)).toBe(2);
    expect(computeExitCode("MEDIUM", "error", false)).toBe(1);
  });
});
