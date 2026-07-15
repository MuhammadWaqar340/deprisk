import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { diffApiSurfaces, extractApiSurface } from "../src/apiDiff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oldEntry = path.join(__dirname, "fixtures/old/index.d.ts");
const newEntry = path.join(__dirname, "fixtures/new/index.d.ts");

describe("extractApiSurface", () => {
  it("extracts top-level exports including re-exports", () => {
    const symbols = extractApiSurface(oldEntry);
    const names = [...symbols.keys()].sort();

    expect(names).toEqual([
      "Options",
      "Result",
      "VERSION",
      "get",
      "map",
      "merge",
      "omit",
      "pick",
    ]);
  });

  it("captures function signatures as strings", () => {
    const symbols = extractApiSurface(oldEntry);
    const merge = symbols.get("merge");
    expect(merge).toBeDefined();
    expect(merge!.signature).toContain("function merge");
    expect(merge!.signature).toContain("a: object");
    expect(merge!.signature).toContain("b: object");
  });
});

describe("diffApiSurfaces", () => {
  it("classifies removed, changed, added, and unchanged symbols", () => {
    const diff = diffApiSurfaces(oldEntry, newEntry);
    const byName = Object.fromEntries(diff.map((e) => [e.name, e]));

    // mapValues is added in new
    expect(byName["mapValues"]?.status).toBe("added");

    // flatten is added via helpers re-export
    expect(byName["flatten"]?.status).toBe("added");

    // merge signature changed (extra opts param)
    expect(byName["merge"]?.status).toBe("changed");
    expect(byName["merge"]?.oldSignature).toBeDefined();
    expect(byName["merge"]?.newSignature).toBeDefined();
    expect(byName["merge"]!.oldSignature).not.toEqual(byName["merge"]!.newSignature);

    // get lost the defaultValue parameter
    expect(byName["get"]?.status).toBe("changed");

    // Result type widened
    expect(byName["Result"]?.status).toBe("changed");

    // Options interface gained a property
    expect(byName["Options"]?.status).toBe("changed");

    // omit gained @deprecated → changed
    expect(byName["omit"]?.status).toBe("changed");
    expect(byName["omit"]?.deprecated).toBe(true);

    // map and VERSION and pick unchanged
    expect(byName["map"]?.status).toBe("unchanged");
    expect(byName["VERSION"]?.status).toBe("unchanged");
    expect(byName["pick"]?.status).toBe("unchanged");
  });

  it("returns one entry per symbol covering the full union", () => {
    const diff = diffApiSurfaces(oldEntry, newEntry);
    const names = diff.map((e) => e.name).sort();

    // old: Options, Result, VERSION, get, map, merge, omit, pick
    // new adds: mapValues, flatten — no removals in this fixture
    expect(names).toContain("merge");
    expect(names).toContain("get");
    expect(names).toContain("mapValues");
    expect(names).toContain("flatten");
    expect(names).toContain("pick");

    const statuses = new Set(diff.map((e) => e.status));
    expect(statuses.has("changed")).toBe(true);
    expect(statuses.has("added")).toBe(true);
    expect(statuses.has("unchanged")).toBe(true);
  });

  it("detects a removed export", () => {
    // Diff new → old so symbols only in old appear as removed from "new's perspective"
    // Actually: old=newEntry, new=oldEntry means things only in oldEntry are "added"
    // and things only in newEntry are "removed".
    // Better: create the scenario by comparing old against a surface missing `get`.
    // We'll just invert: symbols in old not in new.
    // Our fixtures don't remove anything from old→new, so craft via filtering:
    const diff = diffApiSurfaces(oldEntry, newEntry);
    // Nothing removed in old→new fixture — verify zero removals
    expect(diff.filter((e) => e.status === "removed")).toHaveLength(0);

    // Inverse direction: new → old should show mapValues and flatten as removed
    const inverse = diffApiSurfaces(newEntry, oldEntry);
    const removed = inverse.filter((e) => e.status === "removed").map((e) => e.name).sort();
    expect(removed).toEqual(["flatten", "mapValues"]);
  });
});
