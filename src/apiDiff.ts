import { Project, type SourceFile, type ExportedDeclarations, Node } from "ts-morph";
import type { ApiDiffEntry } from "./types.js";

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
  // Pull in sibling .d.ts files so `export * from './x'` resolves.
  const dir = entry.getDirectory();
  project.addSourceFilesAtPaths(`${dir.getPath()}/**/*.d.ts`);

  const symbols = new Map<string, ExtractedSymbol>();
  collectExports(entry, symbols, new Set());
  return symbols;
}

function collectExports(
  sourceFile: SourceFile,
  symbols: Map<string, ExtractedSymbol>,
  visited: Set<string>,
): void {
  const path = sourceFile.getFilePath();
  if (visited.has(path)) return;
  visited.add(path);

  // Direct export declarations via getExportedDeclarations (includes re-exports)
  const exported = sourceFile.getExportedDeclarations();
  for (const [name, declarations] of exported) {
    if (name === "default") {
      // Soft-skip default for now; treat under the name "default"
    }
    if (symbols.has(name)) continue;
    const decl = declarations[0];
    if (!decl) continue;
    symbols.set(name, {
      name,
      signature: formatSignature(name, decl),
      deprecated: hasDeprecatedTag(decl),
    });
  }

  // Also walk export-all statements to ensure re-exported modules are loaded
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
  // Prefer the declaration text when it's a clean named declaration.
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

  // Fallback: normalize whitespace of the full declaration text
  return decl.getText().replace(/\s+/g, " ").trim();
}

function hasDeprecatedTag(decl: ExportedDeclarations): boolean {
  // JSDoc may live on the declaration or its parent (e.g. VariableStatement)
  const nodes: Node[] = [decl];
  const parent = decl.getParent();
  if (parent) nodes.push(parent);
  if (parent && parent.getParent()) nodes.push(parent.getParent()!);

  for (const node of nodes) {
    // ts-morph getJsDocs exists on many declaration kinds
    if ("getJsDocs" in node && typeof (node as { getJsDocs: () => { getTags: () => { getTagName: () => string }[] }[] }).getJsDocs === "function") {
      const docs = (node as { getJsDocs: () => { getTags: () => { getTagName: () => string }[] }[] }).getJsDocs();
      for (const doc of docs) {
        for (const tag of doc.getTags()) {
          if (tag.getTagName() === "deprecated") return true;
        }
      }
    }
  }

  // Also check leading comment ranges for @deprecated (covers some edge cases)
  const fullText = decl.getFullText();
  if (/@deprecated\b/.test(fullText)) return true;

  return false;
}

/**
 * Diff two package .d.ts entry files and classify every exported symbol.
 */
export function diffApiSurfaces(oldTypesEntry: string, newTypesEntry: string): ApiDiffEntry[] {
  const oldSymbols = extractApiSurface(oldTypesEntry);
  const newSymbols = extractApiSurface(newTypesEntry);

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
      const signatureChanged = oldSym.signature !== newSym.signature;
      const newlyDeprecated = !oldSym.deprecated && newSym.deprecated;

      if (signatureChanged || newlyDeprecated) {
        results.push({
          name,
          status: "changed",
          oldSignature: oldSym.signature,
          newSignature: newSym.signature,
          deprecated: newlyDeprecated || newSym.deprecated || undefined,
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
