import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * CCC fitness spec (#830, ADR 0036) — NOT upstream Docmost code.
 *
 * The /socket.io upgrade gate (realtime-socket-bounds.ts `realtimeAccessVerifier`) re-runs the gateway's FIRST
 * authentication step before the upgrade. That is sound only while the two agree: if the gateway started reading
 * another cookie, parser or token type, the gate would refuse honest sockets or wave through ones the gateway then
 * accepts on a different basis. Pinned from the source (AST), both sides:
 * - ws.gateway.ts `handleConnection` parses `client.handshake.headers.cookie` with `cookie.parse`, reads it with
 *   `readDocmostAuthCookie`, and verifies it with `verifyJwt(…, JwtType.ACCESS)`; the verifier does the same three calls;
 * - both import `cookie` with the same specifier and form (cookie 0.7 and 1.x disagree on quoted values);
 * - the gateway's `@WebSocketGateway({...})` spreads REALTIME_GATEWAY_OPTIONS, imported from realtime-socket-bounds
 *   (seam §161), so the transport bounds reach engine.io at construction;
 * - AuthzModule imports RealtimeSocketBoundsModule, which installs the gate.
 */
const SRC = join(__dirname, '..', '..');
const GATEWAY = join(SRC, 'ws', 'ws.gateway.ts');
const BOUNDS = join(SRC, 'authz', 'ws-connection', 'realtime-socket-bounds.ts');
const AUTHZ_MODULE = join(SRC, 'authz', 'authz.module.ts');

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function find<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}
const calls = (root: ts.Node, sf: ts.SourceFile) =>
  find(root, ts.isCallExpression).map((c) => ({
    callee: c.expression.getText(sf),
    args: c.arguments.map((a) => a.getText(sf)),
  }));

/** `import * as <name> from '<spec>'` / named imports, by module specifier. */
function imports(sf: ts.SourceFile): Array<{ spec: string; text: string; names: string[] }> {
  return sf.statements.filter(ts.isImportDeclaration).map((d) => {
    const b = d.importClause?.namedBindings;
    const names = b && ts.isNamedImports(b) ? b.elements.map((e) => e.name.text) : [];
    return { spec: (d.moduleSpecifier as ts.StringLiteral).text, text: d.importClause?.getText(sf) ?? '', names };
  });
}

describe('#830 the upgrade gate authenticates exactly as the gateway does', () => {
  const gw = parse(GATEWAY);
  const bounds = parse(BOUNDS);

  const handleConnection = find(gw, ts.isMethodDeclaration).find((m) => m.name.getText(gw) === 'handleConnection');
  const verifierFn = find(bounds, ts.isFunctionDeclaration).find((f) => f.name?.text === 'realtimeAccessVerifier');

  it('the gateway parses the handshake cookie, reads the resolved auth cookie, and verifies an ACCESS token', () => {
    expect(handleConnection).toBeDefined();
    const c = calls(handleConnection!, gw);
    expect(c).toContainEqual({ callee: 'cookie.parse', args: ['client.handshake.headers.cookie'] });
    expect(c).toContainEqual({ callee: 'readDocmostAuthCookie', args: ['cookies', 'this.environmentService'] });
    const verify = c.find((x) => x.callee === 'this.tokenService.verifyJwt');
    expect(verify?.args[1]).toBe('JwtType.ACCESS');
    expect(verify?.args[0]).toMatch(/^readDocmostAuthCookie\(cookies,/);
  });

  it('the gate makes the same three calls', () => {
    expect(verifierFn).toBeDefined();
    const c = calls(verifierFn!, bounds);
    expect(c).toContainEqual({ callee: 'cookie.parse', args: ['cookieHeader'] });
    const verify = c.find((x) => x.callee === 'tokenService.verifyJwt');
    expect(verify?.args).toEqual(['readDocmostAuthCookie(cookies, env)', 'JwtType.ACCESS']);
  });

  it('both import cookie with the same specifier and form, and readDocmostAuthCookie from session-cookie', () => {
    const cookieOf = (sf: ts.SourceFile) => imports(sf).filter((i) => i.spec === 'cookie').map((i) => i.text);
    expect(cookieOf(gw)).toEqual(['* as cookie']);
    expect(cookieOf(bounds)).toEqual(cookieOf(gw));
    const readerOf = (sf: ts.SourceFile) =>
      imports(sf).find((i) => i.names.includes('readDocmostAuthCookie'))?.spec.replace(/^(\.\.\/)+/, '');
    expect(readerOf(gw)).toBe('authz/session-cookie/docmost-auth-cookie');
    expect(readerOf(bounds)).toBe('session-cookie/docmost-auth-cookie');
  });

  it("the gateway's @WebSocketGateway options spread REALTIME_GATEWAY_OPTIONS from realtime-socket-bounds", () => {
    const decorator = find(gw, ts.isDecorator).find(
      (d) => ts.isCallExpression(d.expression) && d.expression.expression.getText(gw) === 'WebSocketGateway',
    );
    expect(decorator).toBeDefined();
    const [arg] = (decorator!.expression as ts.CallExpression).arguments;
    expect(arg && ts.isObjectLiteralExpression(arg)).toBe(true);
    const spreads = (arg as ts.ObjectLiteralExpression).properties.filter(ts.isSpreadAssignment).map((s) => s.expression.getText(gw));
    expect(spreads).toEqual(['REALTIME_GATEWAY_OPTIONS']);
    // nothing after the spread overrides it
    const props = (arg as ts.ObjectLiteralExpression).properties;
    expect(ts.isSpreadAssignment(props[props.length - 1])).toBe(true);
    expect(imports(gw).find((i) => i.names.includes('REALTIME_GATEWAY_OPTIONS'))?.spec).toBe(
      '../authz/ws-connection/realtime-socket-bounds',
    );
  });

  it('AuthzModule imports RealtimeSocketBoundsModule (read from its @Module decorator)', () => {
    const sf = parse(AUTHZ_MODULE);
    const moduleDecorator = find(sf, ts.isDecorator).find(
      (d) => ts.isCallExpression(d.expression) && d.expression.expression.getText(sf) === 'Module',
    );
    const meta = (moduleDecorator!.expression as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression;
    const importsProp = meta.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'imports',
    );
    const names = (importsProp!.initializer as ts.ArrayLiteralExpression).elements.map((e) => e.getText(sf));
    expect(names).toContain('RealtimeSocketBoundsModule');
  });
});
