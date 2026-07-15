import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";
import type { UsageLocation, UsageMap } from "./types.js";

export interface ScanUsageOptions {
  /** Extra file globs when no tsconfig is found */
  include?: string[];
  /**
   * Follow local barrel re-exports (e.g. `export { merge } from 'lodash'`
   * then `import { merge } from './utils'`).
   */
  followReexports?: boolean;
  /** Additional roots for monorepo packages (absolute or relative to projectDir) */
  extraRoots?: string[];
}

/**
 * Scan a project for usages of exports from `packageName`.
 * With `followReexports: true`, also traces consumer barrel files.
 */
export function scanPackageUsage(
  projectDir: string,
  packageName: string,
  options: ScanUsageOptions = {},
): UsageMap {
  const absDir = path.resolve(projectDir);
  const roots = [absDir, ...(options.extraRoots ?? []).map((r) => path.resolve(absDir, r))];
  const usageMap: UsageMap = {};

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const project = loadProject(root, options.include);
    const reexportLocals = options.followReexports
      ? buildReexportMap(project, packageName)
      : new Map<string, Map<string, string>>();

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (filePath.endsWith(".d.ts")) continue;

      collectFromSourceFile(sourceFile, packageName, root, usageMap);

      if (options.followReexports) {
        collectReexportUsages(sourceFile, reexportLocals, root, usageMap);
      }
    }
  }

  return usageMap;
}

/**
 * Discover workspace package directories (npm/pnpm/yarn workspaces, or packages/*).
 */
export function discoverWorkspaceRoots(projectDir: string): string[] {
  const absDir = path.resolve(projectDir);
  const roots: string[] = [];
  const pkgPath = path.join(absDir, "package.json");
  if (!fs.existsSync(pkgPath)) return roots;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces?.packages ?? [];

    for (const pattern of patterns) {
      // Only support simple globs like "packages/*" or "apps/*"
      if (pattern.endsWith("/*")) {
        const parent = path.join(absDir, pattern.slice(0, -2));
        if (!fs.existsSync(parent)) continue;
        for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            roots.push(path.join(parent, ent.name));
          }
        }
      } else {
        const candidate = path.join(absDir, pattern);
        if (fs.existsSync(candidate)) roots.push(candidate);
      }
    }
  } catch {
    // ignore
  }

  // Fallback common layout
  const packagesDir = path.join(absDir, "packages");
  if (roots.length === 0 && fs.existsSync(packagesDir)) {
    for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (ent.isDirectory()) roots.push(path.join(packagesDir, ent.name));
    }
  }

  return roots;
}

function loadProject(absDir: string, include?: string[]): Project {
  const tsconfigPath = path.join(absDir, "tsconfig.json");

  if (fs.existsSync(tsconfigPath)) {
    try {
      return new Project({ tsConfigFilePath: tsconfigPath });
    } catch {
      // Fall through
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

/**
 * Map: barrelFilePath → (localExportName → originalPackageExportName)
 */
function buildReexportMap(
  project: Project,
  packageName: string,
): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;

    const locals = new Map<string, string>();

    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const spec = exportDecl.getModuleSpecifierValue();
      if (!spec || !isPackageImport(spec, packageName)) continue;

      if (exportDecl.isNamespaceExport()) {
        // export * as ns from 'pkg' — track ns.* later via namespace; skip named map
        continue;
      }

      const named = exportDecl.getNamedExports();
      if (named.length === 0 && !exportDecl.getNamespaceExport()) {
        // export * from 'pkg' — cannot easily rematerialize per-import names into
        // this barrel; skip for v1 of barrel tracing (named re-exports only).
        continue;
      }

      for (const ne of named) {
        const remote = ne.getName();
        const local = ne.getAliasNode()?.getText() ?? remote;
        locals.set(local, remote);
      }
    }

    if (locals.size > 0) {
      map.set(normalizePath(filePath), locals);
    }
  }

  return map;
}

function collectReexportUsages(
  sourceFile: SourceFile,
  reexportLocals: Map<string, Map<string, string>>,
  projectRoot: string,
  usageMap: UsageMap,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const spec = importDecl.getModuleSpecifierValue();
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue;

    const resolved = resolveRelativeModule(sourceFile.getFilePath(), spec);
    if (!resolved) continue;

    const barrel = reexportLocals.get(normalizePath(resolved));
    if (!barrel) continue;

    for (const named of importDecl.getNamedImports()) {
      const remoteFromBarrel = named.getName();
      const local = named.getAliasNode()?.getText() ?? remoteFromBarrel;
      const originalExport = barrel.get(remoteFromBarrel);
      if (!originalExport) continue;

      addUsages(sourceFile, local, originalExport, projectRoot, usageMap, importDecl, {
        includePropertyAccessBase: true,
      });
    }
  }
}

function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function normalizePath(p: string): string {
  return path.normalize(p);
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
      addNamespaceUsages(sourceFile, defaultImport.getText(), projectRoot, usageMap, importDecl);
      addUsages(sourceFile, defaultImport.getText(), "default", projectRoot, usageMap, importDecl);
    }

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
      addNamespaceUsages(sourceFile, namespaceImport.getText(), projectRoot, usageMap, importDecl);
    }

    for (const named of importDecl.getNamedImports()) {
      const remoteName = named.getName();
      const local = named.getAliasNode()?.getText() ?? remoteName;
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
  if (Node.isExportSpecifier(parent)) return true;
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
