import { Project, type SourceFile, type ExportedDeclarations, Node } from "ts-morph";
import type { ApiDiffEntry, ChangeKind } from "./types.js";

export interface ParamInfo {
  name: string;
  optional: boolean;
  rest: boolean;
  typeText: string;
}

export interface FunctionSignatureInfo {
  params: ParamInfo[];
  returnType: string;
  typeParams: string[];
  /** Constraint text per type param (empty string if unconstrained) */
  typeParamConstraints: string[];
}

export interface PropertyInfo {
  name: string;
  optional: boolean;
  typeText: string;
}

export interface MethodInfo {
  name: string;
  signatures: FunctionSignatureInfo[];
}

export interface ExtractedSymbol {
  name: string;
  signature: string;
  deprecated: boolean;
  kind?: "function" | "class" | "interface" | "type" | "enum" | "variable" | "namespace";
  /** Call signatures / overloads when the export is callable */
  callSignatures?: FunctionSignatureInfo[];
  properties?: PropertyInfo[];
  methods?: MethodInfo[];
}

/**
 * Extract the public API surface from a package's .d.ts entry file,
 * following local relative `export … from './…'` re-exports within the package.
 */
export function extractApiSurface(typesEntryPath: string): Map<string, ExtractedSymbol> {
  const project = new Project({
    compilerOptions: {
      allowJs: false,
      declaration: true,
      skipLibCheck: true,
    },
  });

  const entry = project.addSourceFileAtPath(typesEntryPath);
  const dir = entry.getDirectory();
  project.addSourceFilesAtPaths(`${dir.getPath()}/**/*.d.ts`);

  const symbols = new Map<string, ExtractedSymbol>();
  collectExports(entry, symbols, new Set());
  return normalizeDefaultExport(symbols);
}

/**
 * Normalize default / export= shapes so ESM `default` and CJS `export=`
 * are comparable when they represent the same callable surface.
 */
export function normalizeDefaultExport(
  symbols: Map<string, ExtractedSymbol>,
): Map<string, ExtractedSymbol> {
  const result = new Map(symbols);

  const def = result.get("default");
  if (def) {
    const normalized = {
      ...def,
      signature: canonicalizeDefaultSignature(def.signature),
    };
    result.set("default", normalized);
  }

  return result;
}

function canonicalizeDefaultSignature(sig: string): string {
  return sig
    .replace(/^function\s+\w+/, "function default")
    .replace(/^const\s+\w+/, "const default")
    .replace(/^class\s+\w+/, "class default")
    .replace(/\s+/g, " ")
    .trim();
}

function collectExports(
  sourceFile: SourceFile,
  symbols: Map<string, ExtractedSymbol>,
  visited: Set<string>,
): void {
  const filePath = sourceFile.getFilePath();
  if (visited.has(filePath)) return;
  visited.add(filePath);

  const exported = sourceFile.getExportedDeclarations();
  for (const [name, declarations] of exported) {
    if (symbols.has(name)) continue;
    const decl = declarations[0];
    if (!decl) continue;
    symbols.set(name, buildExtractedSymbol(name, declarations));
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    if (exportDecl.isModuleSpecifierRelative()) {
      const target = exportDecl.getModuleSpecifierSourceFile();
      if (target) {
        collectExports(target, symbols, visited);
      }
    }
  }
}

function buildExtractedSymbol(name: string, declarations: ExportedDeclarations[]): ExtractedSymbol {
  const primary = declarations[0]!;
  const signature = formatSignature(name, primary);
  const deprecated = hasDeprecatedTag(primary);
  const structured = extractStructured(name, declarations);

  return {
    name,
    signature,
    deprecated,
    ...structured,
  };
}

function extractStructured(
  name: string,
  declarations: ExportedDeclarations[],
): Pick<ExtractedSymbol, "kind" | "callSignatures" | "properties" | "methods"> {
  const callSignatures: FunctionSignatureInfo[] = [];
  let properties: PropertyInfo[] | undefined;
  let methods: MethodInfo[] | undefined;
  let kind: ExtractedSymbol["kind"];

  for (const decl of declarations) {
    if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
      kind = "function";
      callSignatures.push(signatureFromCallable(decl));
      continue;
    }

    if (Node.isClassDeclaration(decl)) {
      kind = "class";
      const classMethods: MethodInfo[] = [];
      for (const member of decl.getMembers()) {
        if (Node.isMethodDeclaration(member) || Node.isMethodSignature(member)) {
          const mName = member.getName();
          const existing = classMethods.find((m) => m.name === mName);
          const sig = signatureFromCallable(member);
          if (existing) existing.signatures.push(sig);
          else classMethods.push({ name: mName, signatures: [sig] });
        }
        if (Node.isPropertyDeclaration(member) || Node.isPropertySignature(member)) {
          properties ??= [];
          properties.push({
            name: member.getName(),
            optional: member.hasQuestionToken?.() ?? false,
            typeText: member.getTypeNode()?.getText() ?? member.getType().getText(member),
          });
        }
      }
      const ctors = decl.getConstructors();
      for (const ctor of ctors) {
        callSignatures.push(signatureFromCallable(ctor));
      }
      if (classMethods.length) methods = classMethods;
      continue;
    }

    if (Node.isInterfaceDeclaration(decl)) {
      kind = "interface";
      properties = [];
      const ifaceMethods: MethodInfo[] = [];
      for (const member of decl.getMembers()) {
        if (Node.isMethodSignature(member)) {
          const mName = member.getName();
          const existing = ifaceMethods.find((m) => m.name === mName);
          const sig = signatureFromCallable(member);
          if (existing) existing.signatures.push(sig);
          else ifaceMethods.push({ name: mName, signatures: [sig] });
        } else if (Node.isPropertySignature(member) || Node.isPropertyDeclaration(member)) {
          properties.push({
            name: member.getName(),
            optional: member.hasQuestionToken(),
            typeText: member.getTypeNode()?.getText() ?? member.getType().getText(member),
          });
        } else if (Node.isCallSignatureDeclaration(member)) {
          callSignatures.push(signatureFromCallable(member));
        }
      }
      if (ifaceMethods.length) methods = ifaceMethods;
      continue;
    }

    if (Node.isTypeAliasDeclaration(decl)) {
      kind = "type";
      const typeNode = decl.getTypeNode();
      if (typeNode && Node.isFunctionTypeNode(typeNode)) {
        callSignatures.push({
          params: typeNode.getParameters().map(paramFromNode),
          returnType: typeNode.getReturnTypeNode()?.getText() ?? "unknown",
          typeParams: typeNode.getTypeParameters().map((t) => t.getName()),
          typeParamConstraints: typeNode.getTypeParameters().map((t) =>
            t.getConstraint()?.getText() ?? ""
          ),
        });
      } else if (typeNode && Node.isTypeLiteral(typeNode)) {
        properties = [];
        for (const member of typeNode.getMembers()) {
          if (Node.isPropertySignature(member)) {
            properties.push({
              name: member.getName(),
              optional: member.hasQuestionToken(),
              typeText: member.getTypeNode()?.getText() ?? member.getType().getText(member),
            });
          } else if (Node.isMethodSignature(member)) {
            methods ??= [];
            const mName = member.getName();
            const existing = methods.find((m) => m.name === mName);
            const sig = signatureFromCallable(member);
            if (existing) existing.signatures.push(sig);
            else methods.push({ name: mName, signatures: [sig] });
          }
        }
      }
      continue;
    }

    if (Node.isEnumDeclaration(decl)) {
      kind = "enum";
      continue;
    }

    if (Node.isVariableDeclaration(decl)) {
      kind = "variable";
      const typeNode = decl.getTypeNode();
      if (typeNode && Node.isFunctionTypeNode(typeNode)) {
        callSignatures.push({
          params: typeNode.getParameters().map(paramFromNode),
          returnType: typeNode.getReturnTypeNode()?.getText() ?? "unknown",
          typeParams: typeNode.getTypeParameters().map((t) => t.getName()),
          typeParamConstraints: typeNode.getTypeParameters().map((t) =>
            t.getConstraint()?.getText() ?? ""
          ),
        });
      }
      // Overload-style: const fn: { (a: string): T; (a: number): T }
      if (typeNode && Node.isTypeLiteral(typeNode)) {
        for (const member of typeNode.getMembers()) {
          if (Node.isCallSignatureDeclaration(member)) {
            callSignatures.push(signatureFromCallable(member));
          }
        }
      }
      continue;
    }

    if (Node.isModuleDeclaration(decl)) {
      kind = "namespace";
    }
  }

  // Multiple FunctionDeclarations with same name = overloads
  if (declarations.length > 1 && declarations.every((d) => Node.isFunctionDeclaration(d))) {
    kind = "function";
    callSignatures.length = 0;
    for (const d of declarations) {
      if (Node.isFunctionDeclaration(d)) callSignatures.push(signatureFromCallable(d));
    }
  }

  return {
    kind,
    ...(callSignatures.length ? { callSignatures } : {}),
    ...(properties?.length ? { properties } : {}),
    ...(methods?.length ? { methods } : {}),
  };
}

function signatureFromCallable(decl: {
  getParameters: () => import("ts-morph").ParameterDeclaration[];
  getReturnTypeNode?: () => import("ts-morph").TypeNode | undefined;
  getReturnType?: () => { getText: (enclosing?: Node) => string };
  getTypeParameters?: () => import("ts-morph").TypeParameterDeclaration[];
}): FunctionSignatureInfo {
  const params = decl.getParameters().map(paramFromNode);
  const returnType =
    decl.getReturnTypeNode?.()?.getText()
    ?? decl.getReturnType?.()?.getText(decl as unknown as Node)
    ?? "unknown";
  const typeParams = (decl.getTypeParameters?.() ?? []).map((t) => t.getName());
  const typeParamConstraints = (decl.getTypeParameters?.() ?? []).map(
    (t) => t.getConstraint()?.getText() ?? "",
  );
  return { params, returnType, typeParams, typeParamConstraints };
}

function paramFromNode(p: import("ts-morph").ParameterDeclaration): ParamInfo {
  return {
    name: p.getName(),
    optional: p.isOptional(),
    rest: p.isRestParameter(),
    typeText: p.getTypeNode()?.getText() ?? p.getType().getText(p),
  };
}

function formatSignature(name: string, decl: ExportedDeclarations): string {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    const params = decl
      .getParameters()
      .map((p) => p.getText())
      .join(", ");
    const ret = decl.getReturnTypeNode()?.getText() ?? decl.getReturnType().getText(decl);
    const typeParams = decl.getTypeParameters().map((t) => t.getText()).join(", ");
    const tp = typeParams ? `<${typeParams}>` : "";
    return `function ${name}${tp}(${params}): ${ret}`;
  }

  if (Node.isClassDeclaration(decl)) {
    const members = decl
      .getMembers()
      .filter((m) => !Node.isConstructorDeclaration(m) || m.getParameters().length > 0)
      .map((m) => m.getText().replace(/\s+/g, " ").trim())
      .join("; ");
    return `class ${name} { ${members} }`;
  }

  if (Node.isInterfaceDeclaration(decl)) {
    return `interface ${name} ${decl.getText().replace(/^[\s\S]*?\{/, "{").replace(/\s+/g, " ").trim()}`;
  }

  if (Node.isTypeAliasDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    return `type ${name} = ${typeNode?.getText() ?? decl.getType().getText(decl)}`;
  }

  if (Node.isEnumDeclaration(decl)) {
    return `enum ${name} ${decl.getText().replace(/^[\s\S]*?\{/, "{").replace(/\s+/g, " ").trim()}`;
  }

  if (Node.isVariableDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    const typeText = typeNode?.getText() ?? decl.getType().getText(decl);
    const kindKeyword = decl.getVariableStatement()?.getDeclarationKindKeywords()[0];
    const kind = kindKeyword?.getText() ?? "const";
    return `${kind} ${name}: ${typeText}`;
  }

  if (Node.isModuleDeclaration(decl)) {
    return `namespace ${name}`;
  }

  return decl.getText().replace(/\s+/g, " ").trim();
}

function hasDeprecatedTag(decl: ExportedDeclarations): boolean {
  const nodes: Node[] = [decl];
  const parent = decl.getParent();
  if (parent) nodes.push(parent);
  if (parent && parent.getParent()) nodes.push(parent.getParent()!);

  for (const node of nodes) {
    if (
      "getJsDocs" in node
      && typeof (node as { getJsDocs: () => { getTags: () => { getTagName: () => string }[] }[] }).getJsDocs
        === "function"
    ) {
      const docs = (node as { getJsDocs: () => { getTags: () => { getTagName: () => string }[] }[] }).getJsDocs();
      for (const doc of docs) {
        for (const tag of doc.getTags()) {
          if (tag.getTagName() === "deprecated") return true;
        }
      }
    }
  }

  if (/@deprecated\b/.test(decl.getFullText())) return true;
  return false;
}

/**
 * Diff two package .d.ts entry files and classify every exported symbol.
 * Applies default-export canonicalization to reduce false "default removed" noise.
 */
export function diffApiSurfaces(oldTypesEntry: string, newTypesEntry: string): ApiDiffEntry[] {
  const oldSymbols = extractApiSurface(oldTypesEntry);
  const newSymbols = extractApiSurface(newTypesEntry);
  return diffExtractedSurfaces(oldSymbols, newSymbols);
}

/**
 * Diff already-extracted symbol maps (avoids re-parsing when callers need structure).
 */
export function diffExtractedSurfaces(
  oldSymbolsIn: Map<string, ExtractedSymbol>,
  newSymbolsIn: Map<string, ExtractedSymbol>,
): ApiDiffEntry[] {
  const oldSymbols = new Map(oldSymbolsIn);
  const newSymbols = new Map(newSymbolsIn);
  alignDefaultAcrossVersions(oldSymbols, newSymbols);

  const names = new Set([...oldSymbols.keys(), ...newSymbols.keys()]);
  const results: ApiDiffEntry[] = [];

  for (const name of [...names].sort()) {
    const oldSym = oldSymbols.get(name);
    const newSym = newSymbols.get(name);

    if (oldSym && !newSym) {
      results.push({
        name,
        status: "removed",
        oldSignature: oldSym.signature,
        changeKind: "removed",
      });
      continue;
    }

    if (!oldSym && newSym) {
      results.push({
        name,
        status: "added",
        newSignature: newSym.signature,
        deprecated: newSym.deprecated || undefined,
      });
      continue;
    }

    if (oldSym && newSym) {
      const oldCanon = name === "default"
        ? canonicalizeDefaultSignature(oldSym.signature)
        : oldSym.signature;
      const newCanon = name === "default"
        ? canonicalizeDefaultSignature(newSym.signature)
        : newSym.signature;

      const signatureChanged = oldCanon !== newCanon
        || overloadSetChanged(oldSym, newSym);
      const newlyDeprecated = !oldSym.deprecated && newSym.deprecated;

      if (signatureChanged || newlyDeprecated) {
        const changeKind = classifyChangeKindStructured(
          oldSym,
          newSym,
          newlyDeprecated,
          signatureChanged,
        );
        results.push({
          name,
          status: "changed",
          oldSignature: oldSym.signature,
          newSignature: newSym.signature,
          deprecated: newlyDeprecated || newSym.deprecated || undefined,
          changeKind,
        });
      } else {
        results.push({
          name,
          status: "unchanged",
          oldSignature: oldSym.signature,
          newSignature: newSym.signature,
        });
      }
    }
  }

  return results;
}

function overloadSetChanged(oldSym: ExtractedSymbol, newSym: ExtractedSymbol): boolean {
  const oldN = oldSym.callSignatures?.length ?? 0;
  const newN = newSym.callSignatures?.length ?? 0;
  if (oldN !== newN) return true;
  if (oldN <= 1) return false;
  const oldKeys = (oldSym.callSignatures ?? []).map(sigKey).sort().join("|");
  const newKeys = (newSym.callSignatures ?? []).map(sigKey).sort().join("|");
  return oldKeys !== newKeys;
}

function sigKey(s: FunctionSignatureInfo): string {
  return `${s.params.map((p) => `${p.rest ? "..." : ""}${p.optional ? "?" : ""}${p.typeText}`).join(",")}>${s.returnType}`;
}

function alignDefaultAcrossVersions(
  oldSymbols: Map<string, ExtractedSymbol>,
  newSymbols: Map<string, ExtractedSymbol>,
): void {
  const oldDef = oldSymbols.get("default");
  const newDef = newSymbols.get("default");

  if (oldDef && !newDef) {
    const match = findEquivalentExport(newSymbols, oldDef);
    if (match) {
      newSymbols.set("default", {
        ...match,
        name: "default",
        signature: canonicalizeDefaultSignature(match.signature),
      });
    }
  }

  if (newDef && !oldDef) {
    const match = findEquivalentExport(oldSymbols, newDef);
    if (match) {
      oldSymbols.set("default", {
        ...match,
        name: "default",
        signature: canonicalizeDefaultSignature(match.signature),
      });
    }
  }
}

function findEquivalentExport(
  symbols: Map<string, ExtractedSymbol>,
  target: ExtractedSymbol,
): ExtractedSymbol | undefined {
  const targetCanon = canonicalizeDefaultSignature(target.signature);
  for (const [name, sym] of symbols) {
    if (name === "default") continue;
    if (canonicalizeDefaultSignature(sym.signature) === targetCanon) {
      return sym;
    }
  }
  return undefined;
}

export function classifyChangeKindStructured(
  oldSym: ExtractedSymbol,
  newSym: ExtractedSymbol,
  newlyDeprecated: boolean,
  signatureChanged: boolean,
): ChangeKind {
  if (newlyDeprecated && !signatureChanged) return "deprecated";
  if (newlyDeprecated && signatureChanged) return "signature_changed";

  const oldSigs = oldSym.callSignatures;
  const newSigs = newSym.callSignatures;
  if (oldSigs?.length && newSigs?.length) {
    const oldPrimary = oldSigs[0]!;
    const newPrimary = newSigs[0]!;
    const oldRequired = countRequired(oldPrimary);
    const newRequired = countRequired(newPrimary);
    const oldMax = maxArity(oldPrimary);
    const newMax = maxArity(newPrimary);

    if (newMax < oldMax || newRequired < oldRequired && newMax <= oldMax) {
      if (newMax < oldMax) return "param_removed";
    }
    if (newRequired > oldRequired) return "param_added";
    if (newMax > oldMax && newRequired === oldRequired) return "param_added";
    if (oldPrimary.returnType !== newPrimary.returnType) return "return_changed";
  }

  return classifyChangeKind(
    oldSym.signature,
    newSym.signature,
    newlyDeprecated,
    signatureChanged,
  );
}

function countRequired(sig: FunctionSignatureInfo): number {
  let n = 0;
  for (const p of sig.params) {
    if (p.rest) break;
    if (!p.optional) n += 1;
  }
  return n;
}

function maxArity(sig: FunctionSignatureInfo): number {
  if (sig.params.some((p) => p.rest)) return Number.POSITIVE_INFINITY;
  return sig.params.length;
}

export function classifyChangeKind(
  oldSig: string,
  newSig: string,
  newlyDeprecated: boolean,
  signatureChanged: boolean,
): ChangeKind {
  if (newlyDeprecated && !signatureChanged) return "deprecated";
  if (newlyDeprecated && signatureChanged) return "signature_changed";

  const oldParams = countParams(oldSig);
  const newParams = countParams(newSig);
  if (newParams < oldParams) return "param_removed";
  if (newParams > oldParams) return "param_added";

  const oldRet = returnTypeOf(oldSig);
  const newRet = returnTypeOf(newSig);
  if (oldRet && newRet && oldRet !== newRet) return "return_changed";

  if (oldSig.startsWith("type ") || oldSig.startsWith("interface ") || newSig.startsWith("type ") || newSig.startsWith("interface ")) {
    return "type_changed";
  }

  return "signature_changed";
}

function countParams(sig: string): number {
  const match = /\((.*)\)/.exec(sig);
  if (!match || !match[1].trim()) return 0;
  return match[1].split(",").length;
}

function returnTypeOf(sig: string): string | null {
  const match = /\):\s*(.+)$/.exec(sig);
  return match?.[1]?.trim() ?? null;
}

/** Helpers exported for compatibility analysis */
export function requiredArity(sig: FunctionSignatureInfo): number {
  return countRequired(sig);
}

export function maximumArity(sig: FunctionSignatureInfo): number {
  return maxArity(sig);
}
