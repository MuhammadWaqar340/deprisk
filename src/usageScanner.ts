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
  const shape = describeUsageShape(node);
  const loc: UsageLocation = {
    filePath: path.relative(projectRoot, sourceFile.getFilePath()).split(path.sep).join("/"),
    line,
    ...shape,
  };

  if (!usageMap[exportName]) usageMap[exportName] = [];
  const existing = usageMap[exportName].find(
    (u) => u.filePath === loc.filePath && u.line === loc.line,
  );
  if (!existing) {
    usageMap[exportName].push(loc);
    return;
  }
  // Prefer richer call/destructure shapes over bare references on the same line
  if (usageKindRank(loc.kind) > usageKindRank(existing.kind)) {
    Object.assign(existing, loc);
  }
}

function usageKindRank(kind: UsageLocation["kind"]): number {
  switch (kind) {
    case "call":
      return 4;
    case "destructure":
      return 3;
    case "property":
      return 2;
    case "reference":
      return 1;
    default:
      return 0;
  }
}

/**
 * Classify how an identifier (or property name node) is used for call-site analysis.
 */
function describeUsageShape(node: Node): Partial<UsageLocation> {
  const parent = node.getParent();
  if (!parent) return { kind: "reference" };

  // Direct call: foo(...)
  if (Node.isCallExpression(parent) && parent.getExpression() === node) {
    return describeCall(parent);
  }

  // Property access base used in call: foo.bar(...) recorded on bar's name node
  // or namespace _.merge(...)
  if (Node.isPropertyAccessExpression(parent)) {
    const gp = parent.getParent();
    if (Node.isCallExpression(gp) && gp.getExpression() === parent) {
      // If node is the property name (merge in _.merge), this is a call to the export
      if (parent.getNameNode() === node) {
        return describeCall(gp);
      }
      // If node is the base (foo in foo.bar), treat as property access unless it's a call base we skip
      return { kind: "property", propertyName: parent.getName() };
    }
    if (parent.getNameNode() === node) {
      return { kind: "property", propertyName: parent.getName() };
    }
    if (parent.getExpression() === node) {
      return { kind: "property", propertyName: parent.getName() };
    }
  }

  // Element access: obj["x"]
  if (Node.isElementAccessExpression(parent)) {
    const gp = parent.getParent();
    if (Node.isCallExpression(gp) && gp.getExpression() === parent) {
      return describeCall(gp);
    }
    const arg = parent.getArgumentExpression();
    if (arg && Node.isStringLiteral(arg) && parent.getArgumentExpression() === node) {
      return { kind: "property", propertyName: arg.getLiteralText() };
    }
    return { kind: "property" };
  }

  // Destructuring: const { a, b } = foo  OR  const { a } = foo()
  if (Node.isBindingElement(parent) && parent.getNameNode() === node) {
    // This is the local binding name, not the package import — skip unusual
    return { kind: "reference" };
  }

  // Identifier used as RHS of destructuring pattern initializer's subject:
  // const { retries } = options  where options is the import — parent VariableDeclaration
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === node) {
    const nameNode = parent.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      const keys = nameNode.getElements().map((el) => {
        const prop = el.getPropertyNameNode();
        if (prop && Node.isIdentifier(prop)) return prop.getText();
        if (prop && Node.isStringLiteral(prop)) return prop.getLiteralText();
        return el.getName();
      });
      return { kind: "destructure", destructuredKeys: keys };
    }
  }

  // const { x } = foo() — CallExpression as initializer, node is callee
  if (Node.isCallExpression(parent) && parent.getExpression() === node) {
    return describeCall(parent);
  }

  // Assignment from call result destructure: look up VariableDeclaration with call init
  // Handled when node is the call expression's expression — already covered.

  // Wrapper-style: return foo(...) inside function — still a call
  // Covered by CallExpression parent.

  return { kind: "reference" };
}

function describeCall(call: import("ts-morph").CallExpression): Partial<UsageLocation> {
  const args = call.getArguments();
  const argKeys: string[] = [];
  const argTypeHints: string[] = [];
  for (const arg of args) {
    argTypeHints.push(hintArgType(arg));
    if (Node.isObjectLiteralExpression(arg)) {
      for (const prop of arg.getProperties()) {
        if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
          const n = prop.getName();
          if (n) argKeys.push(n);
        }
      }
    }
  }

  const callParent = call.getParent();
  let destructuredKeys: string[] | undefined;
  let propertyName: string | undefined;
  let kind: UsageLocation["kind"] = "call";

  if (Node.isVariableDeclaration(callParent) && callParent.getInitializer() === call) {
    const nameNode = callParent.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      destructuredKeys = nameNode.getElements().map((el) => {
        const prop = el.getPropertyNameNode();
        if (prop && Node.isIdentifier(prop)) return prop.getText();
        if (prop && Node.isStringLiteral(prop)) return prop.getLiteralText();
        return el.getName();
      });
      kind = "destructure";
    } else if (Node.isIdentifier(nameNode)) {
      // const user = getUser(); user.name — detect unsafe vs guarded access
      const access = inspectIdentifierAccesses(nameNode);
      if (access.unsafeProps.length > 0) {
        propertyName = access.unsafeProps[0];
        return {
          kind: "call",
          argCount: args.length,
          argTypeHints,
          ...(argKeys.length ? { argKeys } : {}),
          propertyName,
          returnAccessSafe: false,
        };
      }
      if (access.safeOnly) {
        return {
          kind: "call",
          argCount: args.length,
          argTypeHints,
          ...(argKeys.length ? { argKeys } : {}),
          returnAccessSafe: true,
        };
      }
    }
  }

  // Property access on call: getUser().name
  if (Node.isPropertyAccessExpression(callParent) && callParent.getExpression() === call) {
    propertyName = callParent.getName();
    const optional = callParent.hasQuestionDotToken?.() ?? false;
    if (!optional) {
      // unsafe direct access on possibly-nullable return
      return {
        kind: "call",
        argCount: args.length,
        argTypeHints,
        ...(argKeys.length ? { argKeys } : {}),
        propertyName,
      };
    }
  }

  return {
    kind,
    argCount: args.length,
    argTypeHints,
    ...(argKeys.length ? { argKeys } : {}),
    ...(destructuredKeys?.length ? { destructuredKeys } : {}),
    ...(propertyName ? { propertyName } : {}),
  };
}

function hintArgType(arg: Node): string {
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return "string";
  if (Node.isNumericLiteral(arg)) return "number";
  if (Node.isTrueLiteral(arg) || Node.isFalseLiteral(arg)) return "boolean";
  if (Node.isObjectLiteralExpression(arg)) return "object";
  if (Node.isArrayLiteralExpression(arg)) return "array";
  if (Node.isNullLiteral(arg)) return "null";
  return "unknown";
}

function inspectIdentifierAccesses(id: import("ts-morph").Identifier): {
  unsafeProps: string[];
  safeOnly: boolean;
} {
  const name = id.getText();
  const sourceFile = id.getSourceFile();
  const declPos = id.getStart();
  const unsafeProps: string[] = [];
  let sawAccess = false;
  let allGuarded = true;

  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const expr = access.getExpression();
    if (!Node.isIdentifier(expr) || expr.getText() !== name) continue;
    if (access.getStart() < declPos) continue;
    sawAccess = true;
    if (access.hasQuestionDotToken()) continue;
    if (isInsideNullGuard(access.getExpression(), name)) continue;
    unsafeProps.push(access.getName());
    allGuarded = false;
  }

  return {
    unsafeProps,
    safeOnly: sawAccess && allGuarded && unsafeProps.length === 0,
  };
}

function isInsideNullGuard(ref: Node, bindingName: string): boolean {
  let current: Node | undefined = ref.getParent();
  while (current) {
    if (Node.isIfStatement(current)) {
      const expr = current.getExpression().getText();
      if (expr === bindingName || expr === `!!${bindingName}` || expr.includes(`${bindingName} != null`) || expr.includes(`${bindingName} !== null`) || expr.includes(`${bindingName} !== undefined`)) {
        // ref must be inside then-statement
        const then = current.getThenStatement();
        if (then.containsRange(ref.getStart(), ref.getEnd())) return true;
      }
    }
    current = current.getParent();
  }
  return false;
}
