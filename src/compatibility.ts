import type {
  ApiDiffEntry,
  CompatFinding,
  CompatFindingKind,
  Compatibility,
  Confidence,
  UsageLocation,
  UsageMap,
} from "./types.js";
import type { ExtractedSymbol, FunctionSignatureInfo, PropertyInfo } from "./apiDiff.js";
import { maximumArity, requiredArity } from "./apiDiff.js";

export interface CompatibilityAnalysis {
  findings: CompatFinding[];
  compatibility: Compatibility;
  confidence: Confidence;
  /** Symbols that changed but remain compatible at all analyzed sites */
  compatibleSymbols: string[];
  /** Symbols with incompatible / potentially incompatible findings */
  impactfulSymbols: string[];
}

const COMPAT_RANK: Record<Compatibility, number> = {
  NOT_USED: 0,
  COMPATIBLE: 1,
  UNKNOWN: 2,
  POTENTIALLY_INCOMPATIBLE: 3,
  INCOMPATIBLE: 4,
};

const CONF_RANK: Record<Confidence, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/**
 * Analyze whether actual consumer usages remain compatible with the new API.
 * Only considers exports that are both changed/removed in the diff and present in usage.
 */
export function analyzeCompatibility(input: {
  diff: ApiDiffEntry[];
  usage: UsageMap;
  oldSymbols: Map<string, ExtractedSymbol>;
  newSymbols: Map<string, ExtractedSymbol>;
}): CompatibilityAnalysis {
  const findings: CompatFinding[] = [];
  const compatibleSymbols: string[] = [];
  const impactfulSymbols: string[] = [];

  for (const entry of input.diff) {
    if (entry.status !== "removed" && entry.status !== "changed") continue;
    const usages = input.usage[entry.name];
    if (!usages || usages.length === 0) continue;

    const oldSym = input.oldSymbols.get(entry.name);
    const newSym = input.newSymbols.get(entry.name);
    const symbolFindings = analyzeSymbol(
      entry,
      usages,
      oldSym,
      newSym,
      input.oldSymbols,
      input.newSymbols,
    );
    findings.push(...symbolFindings);

    const worst = worstCompatibility(symbolFindings.map((f) => f.compatibility));
    if (worst === "COMPATIBLE" || worst === "NOT_USED") {
      compatibleSymbols.push(entry.name);
    } else if (worst === "INCOMPATIBLE" || worst === "POTENTIALLY_INCOMPATIBLE") {
      impactfulSymbols.push(entry.name);
    } else {
      // UNKNOWN — still impactful for reporting but not auto-HIGH
      impactfulSymbols.push(entry.name);
    }
  }

  // Secondary: used callables whose signature text is unchanged but named options types changed
  // or return-type methods were removed
  for (const [name, usages] of Object.entries(input.usage)) {
    if (compatibleSymbols.includes(name) || impactfulSymbols.includes(name)) continue;
    const entry = input.diff.find((d) => d.name === name);
    if (entry && (entry.status === "changed" || entry.status === "removed")) continue;
    const oldSym = input.oldSymbols.get(name);
    const newSym = input.newSymbols.get(name);
    if (!oldSym?.callSignatures?.[0] || !newSym?.callSignatures?.[0]) continue;
    const synthetic: ApiDiffEntry = {
      name,
      status: "changed",
      oldSignature: oldSym.signature,
      newSignature: newSym.signature,
      changeKind: "type_changed",
    };
    const opts = analyzeOptionsParam(
      synthetic,
      usages,
      oldSym.callSignatures[0],
      newSym.callSignatures[0],
      input.oldSymbols,
      input.newSymbols,
    );
    const methods = analyzeReturnMethodUsage(
      synthetic,
      usages,
      oldSym.callSignatures[0],
      newSym.callSignatures[0],
      input.oldSymbols,
      input.newSymbols,
    );
    const retProps = analyzeReturnPropertyUsage(
      synthetic,
      usages,
      oldSym.callSignatures[0],
      newSym.callSignatures[0],
      input.oldSymbols,
      input.newSymbols,
    );
    const combined = [...opts, ...methods, ...retProps];
    const impactfulOpts = combined.filter((f) =>
      f.compatibility === "INCOMPATIBLE" || f.compatibility === "POTENTIALLY_INCOMPATIBLE"
    );
    if (impactfulOpts.length === 0) continue;
    findings.push(...impactfulOpts);
    impactfulSymbols.push(name);
  }

  const compatibility = findings.length === 0
    ? "NOT_USED"
    : worstCompatibility(findings.map((f) => f.compatibility));
  const confidence = findings.length === 0
    ? "HIGH"
    : bestConfidence(findings.map((f) => f.confidence));

  return {
    findings,
    compatibility,
    confidence,
    compatibleSymbols,
    impactfulSymbols,
  };
}

function analyzeSymbol(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldSym: ExtractedSymbol | undefined,
  newSym: ExtractedSymbol | undefined,
  oldSymbols: Map<string, ExtractedSymbol>,
  newSymbols: Map<string, ExtractedSymbol>,
): CompatFinding[] {
  if (entry.status === "removed" || !newSym) {
    return usages.map((u) =>
      finding({
        symbol: entry.name,
        kind: "REMOVED",
        compatibility: "INCOMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `Export \`${entry.name}\` was removed but is still used.`,
        recommendation: "Remove or replace this usage before upgrading.",
        oldSignature: entry.oldSignature,
        usageSummary: summarizeUsage(u),
      })
    );
  }

  const out: CompatFinding[] = [];

  // Method removals on class/interface types used via property access
  if (oldSym?.methods && newSym.methods) {
    const removedMethods = oldSym.methods.filter(
      (m) => !newSym.methods!.some((n) => n.name === m.name),
    );
    for (const m of removedMethods) {
      for (const u of usages) {
        if (u.kind === "property" && u.propertyName === m.name) {
          out.push(finding({
            symbol: entry.name,
            kind: "METHOD_REMOVED",
            compatibility: "INCOMPATIBLE",
            confidence: "HIGH",
            file: u.filePath,
            line: u.line,
            reason: `Method \`${m.name}()\` was removed from \`${entry.name}\`.`,
            recommendation: "Update or remove this method call before upgrading.",
            oldSignature: entry.oldSignature,
            newSignature: entry.newSignature,
          }));
        }
      }
    }
  }

  // Interface/type property removals
  if (oldSym?.properties && newSym.properties) {
    const propFindings = analyzeProperties(entry, usages, oldSym.properties, newSym.properties);
    out.push(...propFindings);
  }

  // Callable / overload analysis
  if (oldSym?.callSignatures?.length || newSym.callSignatures?.length) {
    out.push(...analyzeCallable(entry, usages, oldSym, newSym, oldSymbols, newSymbols));
  } else if (entry.changeKind === "type_changed" || entry.changeKind === "signature_changed") {
    // Non-callable type change without property maps
    if (out.length === 0) {
      for (const u of usages) {
        out.push(finding({
          symbol: entry.name,
          kind: "TYPE_CHANGED",
          compatibility: "UNKNOWN",
          confidence: "LOW",
          file: u.filePath,
          line: u.line,
          reason: `Type/signature of \`${entry.name}\` changed; compatibility could not be proven from usage shape.`,
          recommendation: "Review this usage manually before upgrading.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      }
    }
  } else if (entry.changeKind === "deprecated") {
    for (const u of usages) {
      out.push(finding({
        symbol: entry.name,
        kind: "SIGNATURE_CHANGED",
        compatibility: "COMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `\`${entry.name}\` is now marked @deprecated but remains callable.`,
        recommendation: "Plan a migration off this API when convenient.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
      }));
    }
  }

  // If we produced no findings but the export changed and is used, mark UNKNOWN once
  if (out.length === 0) {
    for (const u of usages) {
      out.push(finding({
        symbol: entry.name,
        kind: "UNKNOWN",
        compatibility: "UNKNOWN",
        confidence: "LOW",
        file: u.filePath,
        line: u.line,
        reason: `Used export \`${entry.name}\` changed but call-site compatibility could not be determined.`,
        recommendation: "Review this usage manually.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
    }
  }

  return out;
}

function analyzeProperties(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldProps: PropertyInfo[],
  newProps: PropertyInfo[],
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  const newByName = new Map(newProps.map((p) => [p.name, p]));
  const removed = oldProps.filter((p) => !newByName.has(p.name));
  const newlyRequired = newProps.filter((p) => {
    const old = oldProps.find((o) => o.name === p.name);
    return !p.optional && (old?.optional || !old);
  });

  for (const u of usages) {
    const usedKeys = new Set<string>();
    if (u.kind === "destructure" && u.destructuredKeys) {
      for (const k of u.destructuredKeys) usedKeys.add(k);
    }
    if (u.kind === "property" && u.propertyName) usedKeys.add(u.propertyName);
    if (u.argKeys) for (const k of u.argKeys) usedKeys.add(k);

    for (const prop of removed) {
      if (usedKeys.has(prop.name)) {
        findings.push(finding({
          symbol: entry.name,
          kind: "PROPERTY_REMOVED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `Property \`${prop.name}\` was removed from \`${entry.name}\` but is still used.`,
          recommendation: "Remove this property access or migrate to the replacement API.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
        }));
      }
    }

    // Options-object style: call with object literal keys
    if (u.kind === "call" && u.argKeys?.length) {
      for (const key of u.argKeys) {
        if (removed.some((p) => p.name === key)) {
          findings.push(finding({
            symbol: entry.name,
            kind: "OPTIONS_PROP_REMOVED",
            compatibility: "INCOMPATIBLE",
            confidence: "HIGH",
            file: u.filePath,
            line: u.line,
            reason: `Options property \`${key}\` was removed but is passed at the call site.`,
            recommendation: "Remove the unsupported option before upgrading.",
            oldSignature: entry.oldSignature,
            newSignature: entry.newSignature,
            usageSummary: summarizeUsage(u),
          }));
        }
      }
      for (const req of newlyRequired) {
        if (!u.argKeys.includes(req.name)) {
          findings.push(finding({
            symbol: entry.name,
            kind: "OPTIONS_PROP_REQUIRED",
            compatibility: "INCOMPATIBLE",
            confidence: "HIGH",
            file: u.filePath,
            line: u.line,
            reason: `New required options property \`${req.name}\` is not provided.`,
            recommendation: `Pass \`${req.name}\` in the options object.`,
            oldSignature: entry.oldSignature,
            newSignature: entry.newSignature,
          }));
        }
      }
    }

    // If no keys used from removed set and this is a call without those keys — compatible for props
    if (
      usedKeys.size === 0
      && u.kind === "call"
      && removed.length > 0
      && (!u.argKeys || u.argKeys.length === 0)
    ) {
      // Call without options object — property removals don't affect this site
      findings.push(finding({
        symbol: entry.name,
        kind: "OPTIONS_PROP_REMOVED",
        compatibility: "COMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `Properties were removed from \`${entry.name}\`, but this usage does not reference them.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
    }
  }

  return findings;
}

function analyzeCallable(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldSym: ExtractedSymbol | undefined,
  newSym: ExtractedSymbol,
  oldSymbols?: Map<string, ExtractedSymbol>,
  newSymbols?: Map<string, ExtractedSymbol>,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  const oldSigs = oldSym?.callSignatures ?? [];
  const newSigs = newSym.callSignatures ?? [];

  if (newSigs.length === 0 && oldSigs.length > 0) {
    for (const u of usages) {
      if (u.kind === "call" || u.kind === undefined) {
        findings.push(finding({
          symbol: entry.name,
          kind: "SIGNATURE_CHANGED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `\`${entry.name}\` is no longer callable in the new version.`,
          recommendation: "Update this call before upgrading.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
        }));
      }
    }
    return findings;
  }

  const sitesWithVerdict = new Set<string>();

  if (oldSigs.length > 1 && newSigs.length < oldSigs.length) {
    for (const u of usages) {
      if (u.kind !== "call" && u.kind !== undefined && u.kind !== "reference") continue;
      const key = `${u.filePath}:${u.line}`;
      const argCount = u.argCount ?? (u.kind === "reference" ? undefined : 0);
      if (argCount === undefined) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OVERLOAD_REMOVED",
          compatibility: "UNKNOWN",
          confidence: "LOW",
          file: u.filePath,
          line: u.line,
          reason: `Overload set for \`${entry.name}\` changed; this usage is not a clear call site.`,
          recommendation: "Review manually.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
        }));
        sitesWithVerdict.add(key);
        continue;
      }
      const matchedNew = newSigs.some((s) => callMatchesOverload(s, argCount, u.argTypeHints));
      const matchedOld = oldSigs.some((s) => callMatchesOverload(s, argCount, u.argTypeHints));
      if (matchedNew) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OVERLOAD_REMOVED",
          compatibility: "COMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `An overload was removed, but this call still matches a remaining overload.`,
          recommendation: "Safe to review.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      } else if (matchedOld) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OVERLOAD_REMOVED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `This call matched an overload that was removed and does not match remaining overloads.`,
          recommendation: "Update the call to match a supported overload.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      } else {
        findings.push(finding({
          symbol: entry.name,
          kind: "OVERLOAD_REMOVED",
          compatibility: "UNKNOWN",
          confidence: "LOW",
          file: u.filePath,
          line: u.line,
          reason: `Overload set changed; could not match this call confidently.`,
          recommendation: "Review manually.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
        }));
      }
      sitesWithVerdict.add(key);
    }
  }

  const oldPrimary = oldSigs[0];
  const newPrimary = newSigs[0]!;

  const genericFinding = analyzeGenerics(entry, usages, oldPrimary, newPrimary);
  if (genericFinding) findings.push(...genericFinding);

  findings.push(...analyzeOptionsParam(entry, usages, oldPrimary, newPrimary, oldSymbols, newSymbols));
  findings.push(...analyzeReturnNullability(entry, usages, oldPrimary, newPrimary));
  findings.push(
    ...analyzeReturnMethodUsage(entry, usages, oldPrimary, newPrimary, oldSymbols, newSymbols),
  );
  findings.push(
    ...analyzeReturnPropertyUsage(entry, usages, oldPrimary, newPrimary, oldSymbols, newSymbols),
  );

  for (const u of usages) {
    const key = `${u.filePath}:${u.line}`;
    if (sitesWithVerdict.has(key)) continue;
    if (u.kind === "property") continue;

    if (u.kind === "reference") {
      findings.push(finding({
        symbol: entry.name,
        kind: "UNKNOWN",
        compatibility: "UNKNOWN",
        confidence: "LOW",
        file: u.filePath,
        line: u.line,
        reason: `\`${entry.name}\` is referenced but not as a direct call; compatibility is unknown.`,
        recommendation: "Review this usage manually.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
      }));
      continue;
    }

    if (u.kind === "destructure" && u.argCount === undefined) continue;

    const argCount = u.argCount ?? 0;
    const req = requiredArity(newPrimary);
    const max = maximumArity(newPrimary);
    const oldMax = oldPrimary ? maximumArity(oldPrimary) : max;
    const oldReq = oldPrimary ? requiredArity(oldPrimary) : req;

    if (argCount < req) {
      findings.push(finding({
        symbol: entry.name,
        kind: "PARAM_ADDED_REQUIRED",
        compatibility: "INCOMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason:
          `Your code calls \`${entry.name}()\` with ${argCount} argument(s), `
          + `but the new version requires ${req}.`,
        recommendation: "Provide the new required argument(s) before upgrading.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
      continue;
    }

    if (Number.isFinite(max) && argCount > max) {
      findings.push(finding({
        symbol: entry.name,
        kind: "PARAM_REMOVED",
        compatibility: "INCOMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason:
          `Your code calls \`${entry.name}()\` with ${argCount} argument(s), `
          + `but the new version accepts at most ${max}.`,
        recommendation: "Remove the extra argument(s) before upgrading.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
      continue;
    }

    if (
      oldPrimary
      && req === oldReq
      && max > oldMax
      && Number.isFinite(max)
      && argCount <= oldMax
    ) {
      findings.push(finding({
        symbol: entry.name,
        kind: "PARAM_ADDED_OPTIONAL",
        compatibility: "COMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `Optional parameter(s) were added to \`${entry.name}\`; your call remains valid.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
      continue;
    }

    if (oldPrimary && max < oldMax && argCount <= max && argCount >= req) {
      findings.push(finding({
        symbol: entry.name,
        kind: "PARAM_REMOVED",
        compatibility: "COMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason:
          `Parameter(s) were removed from \`${entry.name}\`, but your call with `
          + `${argCount} argument(s) remains compatible.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
      continue;
    }

    if (!findings.some((f) => f.file === u.filePath && f.line === u.line && f.symbol === entry.name
      && f.compatibility !== "COMPATIBLE")) {
      findings.push(finding({
        symbol: entry.name,
        kind: "SIGNATURE_CHANGED",
        compatibility: "COMPATIBLE",
        confidence: "MEDIUM",
        file: u.filePath,
        line: u.line,
        reason: `API for \`${entry.name}\` changed, but this call site appears arity-compatible.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
    }
  }

  return findings;
}

function analyzeOptionsParam(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldPrimary: FunctionSignatureInfo | undefined,
  newPrimary: FunctionSignatureInfo,
  oldSymbols?: Map<string, ExtractedSymbol>,
  newSymbols?: Map<string, ExtractedSymbol>,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  if (!oldPrimary) return findings;

  const oldLast = oldPrimary.params[oldPrimary.params.length - 1];
  const newLast = newPrimary.params[newPrimary.params.length - 1]
    ?? newPrimary.params[newPrimary.params.length - 1];

  let oldKeys: PropertyInfo[] = [];
  let newKeys: PropertyInfo[] = [];

  if (oldLast) {
    if (oldLast.typeText.includes("{")) {
      oldKeys = parseInlineObjectKeys(oldLast.typeText);
    } else {
      const named = resolveTypeName(oldLast.typeText);
      const sym = named ? oldSymbols?.get(named) : undefined;
      if (sym?.properties) oldKeys = sym.properties;
    }
  }
  if (newLast) {
    if (newLast.typeText.includes("{")) {
      newKeys = parseInlineObjectKeys(newLast.typeText);
    } else {
      const named = resolveTypeName(newLast.typeText);
      const sym = named ? newSymbols?.get(named) : undefined;
      if (sym?.properties) newKeys = sym.properties;
    }
  }

  // When the options param itself was removed
  if (oldLast && !newPrimary.params[oldPrimary.params.length - 1] && oldPrimary.params.length > newPrimary.params.length) {
    // Param removed — arity rules handle excess args; if object keys were passed, incompatible
    for (const u of usages) {
      if (u.kind === "call" && (u.argKeys?.length || (u.argCount ?? 0) >= oldPrimary.params.length)) {
        if ((u.argCount ?? 0) > newPrimary.params.length) {
          // already covered by arity
        }
      }
    }
  }

  if (!oldKeys.length && !newKeys.length) return findings;

  const removedKeys = oldKeys.filter((k) => !newKeys.some((n) => n.name === k.name));
  const newlyRequired = newKeys.filter((p) => {
    const old = oldKeys.find((o) => o.name === p.name);
    return !p.optional && (old?.optional || !old);
  });

  for (const u of usages) {
    if (u.kind !== "call") continue;
    if (!u.argKeys?.length) {
      if (removedKeys.length > 0) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OPTIONS_PROP_REMOVED",
          compatibility: "COMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `Options properties changed on \`${entry.name}\`, but this call does not pass an options object with those keys.`,
          recommendation: "Safe to review.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      }
      continue;
    }

    for (const key of u.argKeys) {
      if (removedKeys.some((r) => r.name === key)) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OPTIONS_PROP_REMOVED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `Options property \`${key}\` is no longer accepted by \`${entry.name}\`.`,
          recommendation: "Remove the unsupported option before upgrading.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      }
    }

    for (const req of newlyRequired) {
      if (!u.argKeys.includes(req.name)) {
        findings.push(finding({
          symbol: entry.name,
          kind: "OPTIONS_PROP_REQUIRED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `New required options property \`${req.name}\` is not provided.`,
          recommendation: `Pass \`${req.name}\` in the options object.`,
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
        }));
      }
    }

    if (
      removedKeys.length > 0
      && u.argKeys.every((k) => !removedKeys.some((r) => r.name === k))
    ) {
      findings.push(finding({
        symbol: entry.name,
        kind: "OPTIONS_PROP_REMOVED",
        compatibility: "COMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `Some options were removed from \`${entry.name}\`, but your call does not use them.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
    }
  }

  return findings;
}

function resolveTypeName(typeText: string): string | null {
  const cleaned = typeText.replace(/\s+/g, " ").trim();
  const m = /^([A-Za-z_$][\w$]*)/.exec(cleaned);
  return m?.[1] ?? null;
}

function parseInlineObjectKeys(typeText: string): PropertyInfo[] {
  // Very small parser: { timeout?: number; retries?: number }
  const body = /\{([^}]*)\}/.exec(typeText)?.[1];
  if (!body) return [];
  const props: PropertyInfo[] = [];
  for (const part of body.split(";")) {
    const m = /^\s*([a-zA-Z_$][\w$]*)(\?)?\s*:/.exec(part);
    if (m) {
      props.push({ name: m[1], optional: Boolean(m[2]), typeText: "unknown" });
    }
  }
  return props;
}

function analyzeReturnPropertyUsage(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldPrimary: FunctionSignatureInfo | undefined,
  newPrimary: FunctionSignatureInfo,
  oldSymbols?: Map<string, ExtractedSymbol>,
  newSymbols?: Map<string, ExtractedSymbol>,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  if (!oldPrimary || !oldSymbols || !newSymbols) return findings;

  const oldTypeName = resolveTypeName(oldPrimary.returnType);
  const newTypeName = resolveTypeName(newPrimary.returnType);
  if (!oldTypeName) return findings;

  const oldType = oldSymbols.get(oldTypeName);
  const newType = newTypeName ? newSymbols.get(newTypeName) : undefined;
  if (!oldType?.properties?.length) return findings;

  const newProps = new Set((newType?.properties ?? []).map((p) => p.name));
  const removed = oldType.properties.filter((p) => !newProps.has(p.name));
  if (removed.length === 0) return findings;

  for (const u of usages) {
    const keys = new Set<string>();
    if (u.destructuredKeys) for (const k of u.destructuredKeys) keys.add(k);
    if (u.propertyName) keys.add(u.propertyName);
    for (const prop of removed) {
      if (keys.has(prop.name)) {
        findings.push(finding({
          symbol: entry.name,
          kind: "PROPERTY_REMOVED",
          compatibility: "INCOMPATIBLE",
          confidence: "HIGH",
          file: u.filePath,
          line: u.line,
          reason: `Property \`${prop.name}\` was removed from return type \`${oldTypeName}\` but is still used.`,
          recommendation: "Remove this property access or destructure before upgrading.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      }
    }
  }
  return findings;
}

function analyzeReturnMethodUsage(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldPrimary: FunctionSignatureInfo | undefined,
  newPrimary: FunctionSignatureInfo,
  oldSymbols?: Map<string, ExtractedSymbol>,
  newSymbols?: Map<string, ExtractedSymbol>,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  if (!oldPrimary || !oldSymbols || !newSymbols) return findings;

  const oldTypeName = resolveTypeName(oldPrimary.returnType);
  const newTypeName = resolveTypeName(newPrimary.returnType);
  if (!oldTypeName) return findings;

  const oldType = oldSymbols.get(oldTypeName);
  const newType = newTypeName ? newSymbols.get(newTypeName) : undefined;
  if (!oldType?.methods?.length) return findings;

  const newMethods = new Set((newType?.methods ?? []).map((m) => m.name));
  const removed = oldType.methods.filter((m) => !newMethods.has(m.name));
  if (removed.length === 0) return findings;

  for (const u of usages) {
    const accessed = u.propertyName;
    if (!accessed) continue;
    if (removed.some((m) => m.name === accessed)) {
      findings.push(finding({
        symbol: entry.name,
        kind: "METHOD_REMOVED",
        compatibility: "INCOMPATIBLE",
        confidence: "HIGH",
        file: u.filePath,
        line: u.line,
        reason: `Method \`${accessed}()\` was removed from return type \`${oldTypeName}\`.`,
        recommendation: "Remove or replace this method call before upgrading.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
      }));
    }
  }
  return findings;
}

function analyzeReturnNullability(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldPrimary: FunctionSignatureInfo | undefined,
  newPrimary: FunctionSignatureInfo,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  if (!oldPrimary) return findings;

  const oldRet = oldPrimary.returnType.replace(/\s+/g, "");
  const newRet = newPrimary.returnType.replace(/\s+/g, "");
  if (oldRet === newRet) return findings;

  const becameNullable =
    (!/\bundefined\b|\bnull\b|\?/.test(oldRet)
      && /\bundefined\b|\bnull\b/.test(newRet))
    || (newRet.includes("|") && !oldRet.includes("|") && /undefined|null/.test(newRet));

  if (!becameNullable) return findings;

  for (const u of usages) {
    if (u.kind !== "call" && u.kind !== "destructure") continue;

    if (u.returnAccessSafe) {
      findings.push(finding({
        symbol: entry.name,
        kind: "RETURN_NULLABLE",
        compatibility: "COMPATIBLE",
        confidence: "MEDIUM",
        file: u.filePath,
        line: u.line,
        reason:
          `Return type of \`${entry.name}\` became nullable, but property access appears null-checked.`,
        recommendation: "Safe to review.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
      }));
      continue;
    }

    if (u.propertyName || (u.destructuredKeys && u.destructuredKeys.length > 0)) {
      findings.push(finding({
        symbol: entry.name,
        kind: "RETURN_NULLABLE",
        compatibility: "POTENTIALLY_INCOMPATIBLE",
        confidence: "MEDIUM",
        file: u.filePath,
        line: u.line,
        reason:
          `Return type changed from \`${oldPrimary.returnType}\` to \`${newPrimary.returnType}\`, `
          + `and the result is property-accessed without a clear null check.`,
        recommendation: "Add a null/undefined check before property access.",
        oldSignature: entry.oldSignature,
        newSignature: entry.newSignature,
        usageSummary: summarizeUsage(u),
      }));
      continue;
    }

    findings.push(finding({
      symbol: entry.name,
      kind: "RETURN_NULLABLE",
      compatibility: "POTENTIALLY_INCOMPATIBLE",
      confidence: "LOW",
      file: u.filePath,
      line: u.line,
      reason:
        `Return type of \`${entry.name}\` became nullable; impact depends on how the result is used.`,
      recommendation: "Verify call sites handle null/undefined.",
      oldSignature: entry.oldSignature,
      newSignature: entry.newSignature,
    }));
  }

  return findings;
}

function analyzeGenerics(
  entry: ApiDiffEntry,
  usages: UsageLocation[],
  oldPrimary: FunctionSignatureInfo | undefined,
  newPrimary: FunctionSignatureInfo,
): CompatFinding[] | null {
  if (!oldPrimary) return null;
  const findings: CompatFinding[] = [];

  for (let i = 0; i < newPrimary.typeParamConstraints.length; i++) {
    const neu = newPrimary.typeParamConstraints[i] ?? "";
    const old = oldPrimary.typeParamConstraints[i] ?? "";
    if (neu && neu !== old) {
      // Constraint added/tightened — can't prove from arity alone
      for (const u of usages) {
        if (u.kind !== "call") continue;
        // Primitive string literal arg vs object constraint — heuristic
        const likelyIncompatible =
          /\bobject\b/.test(neu)
          && (u.argCount === 1); // could be create("hello") vs T extends object

        findings.push(finding({
          symbol: entry.name,
          kind: "GENERIC_CONSTRAINT",
          compatibility: likelyIncompatible ? "POTENTIALLY_INCOMPATIBLE" : "UNKNOWN",
          confidence: "LOW",
          file: u.filePath,
          line: u.line,
          reason:
            `Generic constraint tightened to \`${neu}\`; static proof of argument assignability is limited.`,
          recommendation: "Verify type arguments manually; DepRisk does not treat this as proven HIGH risk.",
          oldSignature: entry.oldSignature,
          newSignature: entry.newSignature,
          usageSummary: summarizeUsage(u),
        }));
      }
    }
  }

  return findings.length ? findings : null;
}

function arityFits(sig: FunctionSignatureInfo, argCount: number): boolean {
  const req = requiredArity(sig);
  const max = maximumArity(sig);
  if (argCount < req) return false;
  if (Number.isFinite(max) && argCount > max) return false;
  return true;
}

function callMatchesOverload(
  sig: FunctionSignatureInfo,
  argCount: number,
  argTypeHints?: string[],
): boolean {
  if (!arityFits(sig, argCount)) return false;
  if (!argTypeHints?.length) return true;
  for (let i = 0; i < Math.min(argTypeHints.length, sig.params.length); i++) {
    const hint = argTypeHints[i]!;
    if (hint === "unknown") continue;
    const paramType = sig.params[i]!.typeText.replace(/\s+/g, "");
    if (hint === "string" && !/\bstring\b/.test(paramType) && paramType !== "any") return false;
    if (hint === "number" && !/\bnumber\b/.test(paramType) && paramType !== "any") return false;
    if (hint === "boolean" && !/\bboolean\b/.test(paramType) && paramType !== "any") return false;
    if (hint === "object" && /\b(string|number|boolean)\b/.test(paramType) && !paramType.includes("|")) {
      return false;
    }
  }
  return true;
}

function summarizeUsage(u: UsageLocation): string {
  if (u.kind === "call") {
    const keys = u.argKeys?.length ? ` keys=[${u.argKeys.join(",")}]` : "";
    return `call with ${u.argCount ?? 0} arg(s)${keys}`;
  }
  if (u.kind === "destructure") {
    return `destructure { ${u.destructuredKeys?.join(", ") ?? ""} }`;
  }
  if (u.kind === "property") {
    return `property .${u.propertyName ?? "?"}`;
  }
  return u.kind ?? "reference";
}

function finding(
  partial: CompatFinding,
): CompatFinding {
  return partial;
}

export function worstCompatibility(list: Compatibility[]): Compatibility {
  let worst: Compatibility = "NOT_USED";
  for (const c of list) {
    if (COMPAT_RANK[c] > COMPAT_RANK[worst]) worst = c;
  }
  return worst;
}

export function bestConfidence(list: Confidence[]): Confidence {
  // For aggregate report confidence: use the confidence of the worst finding's peer —
  // prefer highest confidence among findings that share the worst compatibility.
  let best: Confidence = "UNKNOWN";
  for (const c of list) {
    if (CONF_RANK[c] > CONF_RANK[best]) best = c;
  }
  return best;
}

export function compatibilityToRiskHint(
  compatibility: Compatibility,
  confidence: Confidence,
  hasRemoval: boolean,
): "HIGH" | "MEDIUM" | "LOW" {
  switch (compatibility) {
    case "INCOMPATIBLE":
      return "HIGH";
    case "POTENTIALLY_INCOMPATIBLE":
      return "MEDIUM";
    case "UNKNOWN":
      // Never auto-HIGH on UNKNOWN
      return hasRemoval && confidence !== "LOW" ? "MEDIUM" : "MEDIUM";
    case "COMPATIBLE":
    case "NOT_USED":
    default:
      return "LOW";
  }
}
