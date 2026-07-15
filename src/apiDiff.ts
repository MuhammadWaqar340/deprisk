import { Project, type SourceFile, type ExportedDeclarations, Node } from "ts-morph";
import type { ApiDiffEntry, ChangeKind } from "./types.js";

export interface ExtractedSymbol {
  name: string;
  signature: string;
  deprecated: boolean;
}

/**
 * Extract the public API surface from a package's .d.ts entry file,
 * following local `export * from './…'` re-exports within the package.
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

  // Common pattern: both `default` and a same-named callable; keep both but
  // canonicalize default signature to strip "default" vs package-name aliases.
  const def = result.get("default");
  if (def) {
    const normalized = {
      ...def,
      signature: canonicalizeDefaultSignature(def.signature),
    };
    result.set("default", normalized);
  }

  // If only a non-default export named like the main export exists and there's
  // no default, leave as-is. If we have `export = fn` represented as default
  // in one version and as a named export that mirrors default in another,
  // align via signature equality checked later in diff.
  return result;
}

function canonicalizeDefaultSignature(sig: string): string {
  // "function default(...): T" and "function clsx(...): T" → compare param/return shape
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
    symbols.set(name, {
      name,
      signature: formatSignature(name, decl),
      deprecated: hasDeprecatedTag(decl),
    });
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

  // If old has `default` and new lost it but gained an equivalent-shaped export
  // (or vice versa), treat matching canonical signatures as unchanged default.
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

      const signatureChanged = oldCanon !== newCanon;
      const newlyDeprecated = !oldSym.deprecated && newSym.deprecated;

      if (signatureChanged || newlyDeprecated) {
        const changeKind = classifyChangeKind(
          oldSym.signature,
          newSym.signature,
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

/**
 * When one side only has `default` and the other only has a primary named export
 * with the same canonical signature, copy default onto both maps so we don't
 * spuriously mark default as removed/added.
 */
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
        name: "default",
        signature: canonicalizeDefaultSignature(match.signature),
        deprecated: match.deprecated,
      });
    }
  }

  if (newDef && !oldDef) {
    const match = findEquivalentExport(oldSymbols, newDef);
    if (match) {
      oldSymbols.set("default", {
        name: "default",
        signature: canonicalizeDefaultSignature(match.signature),
        deprecated: match.deprecated,
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
