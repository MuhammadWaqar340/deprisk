import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";
import type { UsageLocation, UsageMap } from "./types.js";

export interface ScanUsageOptions {
  /** Extra file globs when no tsconfig is found */
  include?: string[];
}

/**
 * Scan a project for direct usages of exports imported from `packageName`.
 * Does not follow consumer re-exports (v1 scope).
 */
export function scanPackageUsage(
  projectDir: string,
  packageName: string,
  options: ScanUsageOptions = {},
): UsageMap {
  const absDir = path.resolve(projectDir);
  const project = loadProject(absDir, options.include);
  const usageMap: UsageMap = {};

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (filePath.endsWith(".d.ts")) continue;

    collectFromSourceFile(sourceFile, packageName, absDir, usageMap);
  }

  return usageMap;
}

function loadProject(absDir: string, include?: string[]): Project {
  const tsconfigPath = path.join(absDir, "tsconfig.json");

  if (fs.existsSync(tsconfigPath)) {
    try {
      return new Project({ tsConfigFilePath: tsconfigPath });
    } catch {
      // Fall through to manual file discovery if tsconfig is unusable
    }
  }

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 4,
      target: 99,
      module: 99,
      moduleResolution: 100,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });

  const patterns = include ?? [path.join(absDir, "**/*.{ts,tsx,js,jsx}")];
  project.addSourceFilesAtPaths(patterns);

  for (const sf of [...project.getSourceFiles()]) {
    if (sf.getFilePath().includes(`${path.sep}node_modules${path.sep}`)) {
      project.removeSourceFile(sf);
    }
  }

  return project;
}

function collectFromSourceFile(
  sourceFile: SourceFile,
  packageName: string,
  projectRoot: string,
  usageMap: UsageMap,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const spec = importDecl.getModuleSpecifierValue();
    if (!isPackageImport(spec, packageName)) continue;

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      // Property access on the default binding (lodash.trim) maps to export names.
      addNamespaceUsages(sourceFile, defaultImport.getText(), projectRoot, usageMap, importDecl);
      // Direct calls/refs to the default binding itself.
      addUsages(sourceFile, defaultImport.getText(), "default", projectRoot, usageMap, importDecl);
    }

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
      addNamespaceUsages(sourceFile, namespaceImport.getText(), projectRoot, usageMap, importDecl);
    }

    for (const named of importDecl.getNamedImports()) {
      const remoteName = named.getName();
      const local = named.getAliasNode()?.getText() ?? remoteName;
      // Count all refs to the local binding as usage of the remote export,
      // including `z.object`-style property access on a named import.
      addUsages(sourceFile, local, remoteName, projectRoot, usageMap, importDecl, {
        includePropertyAccessBase: true,
      });
    }
  }

  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;

      if (!findRequireCall(init, packageName)) continue;

      const nameNode = decl.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        addNamespaceUsages(sourceFile, nameNode.getText(), projectRoot, usageMap, decl);
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          const prop = element.getPropertyNameNode()?.getText() ?? element.getName();
          const local = element.getName();
          addUsages(sourceFile, local, prop, projectRoot, usageMap, decl);
        }
      }
    }
  }
}

function isPackageImport(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function findRequireCall(node: Node, packageName: string): boolean {
  if (!Node.isCallExpression(node)) return false;
  const expr = node.getExpression();
  if (!Node.isIdentifier(expr) || expr.getText() !== "require") return false;
  const arg = node.getArguments()[0];
  return Boolean(
    arg && Node.isStringLiteral(arg) && isPackageImport(arg.getLiteralText(), packageName),
  );
}

function addUsages(
  sourceFile: SourceFile,
  localName: string,
  exportName: string,
  projectRoot: string,
  usageMap: UsageMap,
  importNode: Node,
  options: { includePropertyAccessBase?: boolean } = {},
): void {
  const importStart = importNode.getStart();
  const importEnd = importNode.getEnd();

  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== localName) continue;
    const pos = id.getStart();
    if (pos >= importStart && pos <= importEnd) continue;
    if (isDeclarationName(id)) continue;
    // Skip namespace-style property access unless caller wants those counted
    // (named imports used as namespaces, e.g. `z.object`, should count).
    if (!options.includePropertyAccessBase) {
      const parent = id.getParent();
      if (
        parent
        && (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent))
        && parent.getExpression() === id
      ) {
        continue;
      }
    }
    pushUsage(usageMap, exportName, sourceFile, id, projectRoot);
  }
}

function addNamespaceUsages(
  sourceFile: SourceFile,
  localName: string,
  projectRoot: string,
  usageMap: UsageMap,
  importNode: Node,
): void {
  const importStart = importNode.getStart();
  const importEnd = importNode.getEnd();

  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const expr = access.getExpression();
    if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;
    const pos = access.getStart();
    if (pos >= importStart && pos <= importEnd) continue;
    pushUsage(usageMap, access.getName(), sourceFile, access.getNameNode(), projectRoot);
  }

  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const expr = access.getExpression();
    if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;
    const arg = access.getArgumentExpression();
    if (!arg || !Node.isStringLiteral(arg)) continue;
    const pos = access.getStart();
    if (pos >= importStart && pos <= importEnd) continue;
    pushUsage(usageMap, arg.getLiteralText(), sourceFile, arg, projectRoot);
  }
}

function isDeclarationName(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === id) return true;
  if (Node.isClassDeclaration(parent) && parent.getNameNode() === id) return true;
  if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) return true;
  if (Node.isParameterDeclaration(parent) && parent.getNameNode() === id) return true;
  if (Node.isImportSpecifier(parent)) return true;
  if (Node.isImportClause(parent)) return true;
  if (Node.isNamespaceImport(parent)) return true;
  if (Node.isBindingElement(parent) && parent.getNameNode() === id) return true;
  return false;
}

function pushUsage(
  usageMap: UsageMap,
  exportName: string,
  sourceFile: SourceFile,
  node: Node,
  projectRoot: string,
): void {
  const { line } = sourceFile.getLineAndColumnAtPos(node.getStart());
  const loc: UsageLocation = {
    filePath: path.relative(projectRoot, sourceFile.getFilePath()).split(path.sep).join("/"),
    line,
  };

  if (!usageMap[exportName]) usageMap[exportName] = [];
  if (!usageMap[exportName].some((u) => u.filePath === loc.filePath && u.line === loc.line)) {
    usageMap[exportName].push(loc);
  }
}
