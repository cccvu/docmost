import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * CCC Layer-C static route scanner — NOT upstream Docmost code (GitHub #13).
 *
 * Enumerates every Nest controller route by PARSING the source of each `*.controller.ts` with the TypeScript
 * compiler API — deliberately NOT by importing/booting anything. Import-based reflection would drag each
 * controller's entire transitive service graph through jest (workspace packages that must be pre-built, `.tsx`
 * email templates the fork's jest config doesn't resolve, DB/Redis modules), making the fitness function
 * fragile to unrelated changes. A pure text/AST scan is immune to all of that: no build, no DB, no imports.
 * It reads decorators exactly as written, yielding a STATIC SUPERSET of the runtime route set — the
 * fail-closed posture a route-inventory guard wants (it can only over-report, never miss a written route).
 *
 * Guards are matched by NAME (the identifier in `@UseGuards(...)`), consistent with how the runtime
 * PlatformAuthorizationGuard matches (see AUTH_GUARD_NAMES in route-classification.ts).
 */

export interface StaticRoute {
  file: string; // relative to srcRoot
  controller: string; // class name
  handler: string; // method name
  /** @Public() (Docmost) or @PlatformPublic() on the class or the handler. */
  isPublic: boolean;
  /** @PlatformAuthz(...) on the class or the handler. */
  isForkAuthz: boolean;
  /** @NativeCredentialRoute() on the class or the handler (native-auth mode gate marker, seam #87/#88). */
  isNativeCredentialRoute: boolean;
  /** Guard identifier names from @UseGuards(...) on the class + handler (deduped). */
  guardNames: string[];
  /**
   * The handler BODY mints a native session cookie — `res.setCookie('authToken', …)` or the AuthController
   * `this.setAuthCookie(…)` helper. A static (text) tell, deliberately over-reporting: it lets a fitness
   * test assert "every native-session route is @NativeCredentialRoute()" so a NEW unmarked session-minting
   * route (the invites/accept-class gap) cannot merge silently. See native-credential-routes.spec.ts.
   */
  mintsNativeSession: boolean;
}

// Text tell that a handler body establishes a native session (mints the `authToken` cookie). Matches
// `setCookie('authToken'` / `setCookie("authToken"` (direct) and `setAuthCookie(` (the AuthController helper).
const NATIVE_SESSION_MINT_RE = /setCookie\(\s*['"]authToken['"]|setAuthCookie\s*\(/;

const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All', 'Search']);
const PUBLIC_DECORATORS = new Set(['Public', 'PlatformPublic']);
const FORK_AUTHZ_DECORATORS = new Set(['PlatformAuthz']);
const NATIVE_CREDENTIAL_DECORATORS = new Set(['NativeCredentialRoute']);
const SKIP_DIRS = new Set(['ee', 'node_modules', 'dist']);

function walkControllerFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walkControllerFiles(full, out);
    } else if (name.endsWith('.controller.ts') && !name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
}

/** The decorator's identifier name (`@Get(...)` -> "Get", `@UseGuards(...)` -> "UseGuards"), or undefined. */
function decoratorName(dec: ts.Decorator): string | undefined {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text; // bare `@Public` (no parens) — defensive
  return undefined;
}

/** The trailing identifier of an expression: `JwtAuthGuard` or `guards.JwtAuthGuard` -> "JwtAuthGuard". */
function trailingName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isNewExpression(expr)) return trailingName(expr.expression); // @UseGuards(new Foo())
  return undefined;
}

interface DecoratorFacts {
  isPublic: boolean;
  isForkAuthz: boolean;
  isNativeCredentialRoute: boolean;
  guardNames: string[];
}

function readDecorators(node: ts.HasDecorators): DecoratorFacts {
  const facts: DecoratorFacts = {
    isPublic: false,
    isForkAuthz: false,
    isNativeCredentialRoute: false,
    guardNames: [],
  };
  for (const dec of ts.getDecorators(node) ?? []) {
    const name = decoratorName(dec);
    if (name && PUBLIC_DECORATORS.has(name)) facts.isPublic = true;
    if (name && FORK_AUTHZ_DECORATORS.has(name)) facts.isForkAuthz = true;
    if (name && NATIVE_CREDENTIAL_DECORATORS.has(name)) facts.isNativeCredentialRoute = true;
    if (name === 'UseGuards' && ts.isCallExpression(dec.expression)) {
      for (const arg of dec.expression.arguments) {
        const g = trailingName(arg);
        if (g) facts.guardNames.push(g);
      }
    }
  }
  return facts;
}

/** Scan every controller under srcRoot and return one StaticRoute per route handler. */
export function scanRoutes(srcRoot: string): StaticRoute[] {
  const files: string[] = [];
  walkControllerFiles(srcRoot, files);
  files.sort();

  const routes: StaticRoute[] = [];
  for (const full of files) {
    const file = full.slice(srcRoot.length + 1);
    const src = readFileSync(full, 'utf8');
    const sf = ts.createSourceFile(full, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const classFacts = readDecorators(stmt);
      const isController = (ts.getDecorators(stmt) ?? []).some((d) => decoratorName(d) === 'Controller');
      if (!isController) continue;
      const controller = stmt.name.text;

      for (const member of stmt.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        const mDecs = ts.getDecorators(member) ?? [];
        const isRoute = mDecs.some((d) => {
          const n = decoratorName(d);
          return n !== undefined && ROUTE_DECORATORS.has(n);
        });
        if (!isRoute) continue;

        const methodFacts = readDecorators(member);
        routes.push({
          file,
          controller,
          handler: member.name.text,
          isPublic: classFacts.isPublic || methodFacts.isPublic,
          isForkAuthz: classFacts.isForkAuthz || methodFacts.isForkAuthz,
          isNativeCredentialRoute:
            classFacts.isNativeCredentialRoute || methodFacts.isNativeCredentialRoute,
          mintsNativeSession: NATIVE_SESSION_MINT_RE.test(member.getText(sf)),
          guardNames: [...new Set([...classFacts.guardNames, ...methodFacts.guardNames])],
        });
      }
    }
  }
  return routes;
}
