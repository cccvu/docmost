import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * CCC fitness test (#810, ADR 0036) — NOT upstream Docmost code.
 *
 * The collab socket bounds are ONE object per process (socket-bounds.ts). Their parts share state across seams that
 * never call each other (the adapter's slot and the bounded socket's release; the auth extension's early cap check and
 * the gateway's `connected` hook; that hook's socket documents and the keepalive's reaper), and a part split across
 * two instances fails silently. So:
 * - only socket-bounds.ts builds a part, and never at module level (no process singleton, no default argument);
 * - only `collabSocketBoundsProvider` builds a `CollabSocketBounds` (Nest makes it once);
 * - only `CollabSocketBounds.open` wires a socket (the bounded socket, the frame check, the keepalive), and the gateway
 *   calls it exactly once on each of its two paths;
 * - every seam takes the injected instance.
 */
const SRC = join(__dirname, '..', '..');
const BOUNDS_FILE = 'authz/collab-ingress/socket-bounds.ts';
const PARTS = [
  'CollabPreAuthSlots',
  'CollabUserConnections',
  'CollabSocketDocuments',
  'CollabAuthRate',
  'CollabUserConnectionsExtension',
  'BoundedCollabSocket',
  'CollabClientTrust', // #810: one trust fetch per process, shared with the public-surface throttler
  'CollabSocketBytes', // #810: one byte budget per process (the adapter tracks, the bounded socket charges)
];
const WIRING_CALLS = ['keepCollabSocketAlive', 'admitCollabFrame'];

/** Every production source under src/ (specs, testkits and declarations excluded), as a path relative to src/. */
function productionSources(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...productionSources(full));
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testkit|d)\.ts$/.test(entry.name)) {
      out.push(relative(SRC, full).split(sep).join('/'));
    }
  }
  return out;
}

const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
/**
 * The name of the nearest enclosing function-like ('constructor', a method, a named function or property), or null at
 * module level.
 */
const enclosingFunction = (n: ts.Node): string | null => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isConstructorDeclaration(p)) return 'constructor';
    if (ts.isFunctionLike(p)) {
      const named = (p as ts.SignatureDeclaration).name;
      if (named) return named.getText();
      if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
        // a property's function (`useFactory: () => …`, a class field) is named by its property; a callback or an
        // immediately invoked one by what encloses it
        if (ts.isPropertyAssignment(p.parent) || ts.isPropertyDeclaration(p.parent)) return p.parent.name.getText();
        continue;
      }
      return '<anonymous>';
    }
  }
  return null;
};
const enclosingVariable = (n: ts.Node): string | null => {
  for (let p = n.parent; p; p = p.parent) if (ts.isVariableDeclaration(p)) return p.name.getText();
  return null;
};

interface Finding {
  file: string;
  what: string;
  /** The enclosing function (callbacks are named by what encloses them), or null at module level. */
  fn: string | null;
  variable: string | null;
}

/** Every `new <name>(…)` and call to a `calls` function in `text`. */
function scan(file: string, text: string, names: string[], calls: string[] = []): Finding[] {
  if (![...names, ...calls].some((n) => text.includes(n))) return [];
  const found: Finding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n) && names.includes(n.expression.getText())) {
      found.push({ file, what: `new ${n.expression.getText()}`, fn: enclosingFunction(n), variable: enclosingVariable(n) });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && calls.includes(n.expression.text)) {
      found.push({ file, what: `${n.expression.text}()`, fn: enclosingFunction(n), variable: enclosingVariable(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(file, text));
  return found;
}

/** Parts or wiring calls outside socket-bounds.ts, and any part built at module level (a singleton) anywhere. */
function partViolations(file: string, text: string): Finding[] {
  return scan(file, text, PARTS, WIRING_CALLS).filter((f) => f.file !== BOUNDS_FILE || f.fn === null);
}

/** `this.collabSocketBounds.open(` calls in each branch of the gateway's handleConnection if/else. */
function openCallsPerBranch(text: string): number[] | null {
  let branches: number[] | null = null;
  const count = (s: ts.Node | undefined) => {
    let n = 0;
    const walk = (m: ts.Node) => {
      if (ts.isCallExpression(m) && m.expression.getText() === 'this.collabSocketBounds.open') n++;
      ts.forEachChild(m, walk);
    };
    if (s) walk(s);
    return n;
  };
  const visit = (n: ts.Node) => {
    if (ts.isMethodDeclaration(n) && n.name.getText() === 'handleConnection' && n.body) {
      const branch = n.body.statements.find(ts.isIfStatement);
      if (branch) branches = [count(branch.thenStatement), count(branch.elseStatement)];
    }
    ts.forEachChild(n, visit);
  };
  visit(parse('gateway.ts', text));
  return branches;
}

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (text: string) => text.replace(/\/\/.*$/gm, ''); // comments may name it; code may not

describe('#810 fitness: one CollabSocketBounds per process', () => {
  const files = productionSources();

  it('the scan sees the tree (anti-vacuity: the seam files and socket-bounds.ts are in it)', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const f of [BOUNDS_FILE, 'collaboration/collaboration.gateway.ts', 'collaboration/adapter/collab-ws.adapter.ts']) {
      expect(files).toContain(f);
    }
    // and socket-bounds.ts builds each part exactly once (the auth rate twice: per session and per user, #810), in its
    // constructor, and wires a socket only in open()
    const own = scan(BOUNDS_FILE, read(BOUNDS_FILE), PARTS, WIRING_CALLS).map((f) => `${f.fn}: ${f.what}`);
    expect(own.sort()).toEqual(
      [
        ...PARTS.filter((p) => p !== 'BoundedCollabSocket').map((p) => `constructor: new ${p}`),
        'constructor: new CollabAuthRate',
        'open: new BoundedCollabSocket',
        ...WIRING_CALLS.map((c) => `open: ${c}()`),
      ].sort(),
    );
  });

  it('only socket-bounds.ts builds a part or wires a socket, and nothing builds a part at module level', () => {
    const violations = files.flatMap((f) => partViolations(f, read(f)));
    expect(violations).toEqual([]);
  });

  it('only collabSocketBoundsProvider builds a CollabSocketBounds', () => {
    const builds = files.flatMap((f) => scan(f, read(f), ['CollabSocketBounds']));
    expect(builds).toEqual([{ file: BOUNDS_FILE, what: 'new CollabSocketBounds', fn: 'useFactory', variable: 'collabSocketBoundsProvider' }]);
  });

  it('anti-vacuity: the scans catch the singletons and the per-path wiring they replaced', () => {
    expect(partViolations('authz/collab-ingress/user-connections.ts', 'const processConnections = new CollabUserConnections();')).toHaveLength(1);
    expect(partViolations('authz/collab-ingress/socket-documents.ts', 'export const collabSocketDocuments = new CollabSocketDocuments();')).toHaveLength(1);
    // a module-level singleton inside socket-bounds.ts itself is refused too
    expect(partViolations(BOUNDS_FILE, 'export const collabPreAuthSlots = new CollabPreAuthSlots();')).toHaveLength(1);
    // so is a default argument pointing at one
    expect(partViolations('authz/collab-ingress/x.ts', 'function f(c = new CollabAuthRate()) { return c; }')).toHaveLength(1);
    const oldGateway = `class G { handleConnection(client, request) {
      if (this.redisSync) {
        const wrappedSocket = new BoundedCollabSocket(client, new WsSocketWrapper(client));
        keepCollabSocketAlive(client, () => clientConnection.touch());
        client.on('message', (data) => { if (!admitCollabFrame(client, data)) return; });
      } else {
        keepCollabSocketAlive(client, () => clientConnection.touch());
      } } }`;
    expect(partViolations('collaboration/collaboration.gateway.ts', oldGateway).map((f) => f.what)).toEqual([
      'new BoundedCollabSocket',
      'keepCollabSocketAlive()',
      'admitCollabFrame()',
      'keepCollabSocketAlive()',
    ]);
    expect(openCallsPerBranch(oldGateway)).toEqual([0, 0]);
    expect(scan('x.ts', 'const b = new CollabSocketBounds();', ['CollabSocketBounds'])).toHaveLength(1);
  });

  it('the gateway opens every socket through bounds.open, exactly once on each path (RedisSync and standalone)', () => {
    expect(openCallsPerBranch(read('collaboration/collaboration.gateway.ts'))).toEqual([1, 1]);
  });

  it('every seam takes the injected instance', () => {
    const gateway = code(read('collaboration/collaboration.gateway.ts'));
    expect(gateway).toMatch(/private readonly collabSocketBounds: CollabSocketBounds/);
    expect(gateway).toMatch(/this\.collabSocketBounds\.userConnectionsExtension,/);

    const extension = code(read('collaboration/extensions/authentication.extension.ts'));
    expect(extension).toMatch(/private readonly collabSocketBounds: CollabSocketBounds/);
    expect(extension).toMatch(/this\.collabSocketBounds\.chargeSession\(userId, jwtPayload\.sessionId\);\s*this\.collabSocketBounds\.admitUser\(userId\);/);
    expect(extension).toMatch(/this\.collabSocketBounds\.chargeUser\(userId\);/);
    expect(extension).toMatch(/throw this\.collabSocketBounds\.invalidToken\(error\);/);
    expect(gateway).toMatch(/this\.collabSocketBounds\.quietAuthRefusals\(this\.authenticationExtension\),/);
    expect(gateway).not.toMatch(/^\s*this\.authenticationExtension,\s*$/m); // never the bare extension (#810 L1)
    // a value import: `import type` would drop the constructor's design:paramtypes, and Nest could not inject it
    expect(extension).toMatch(/^import \{ CollabSocketBounds \} from '\.\.\/\.\.\/authz\/collab-ingress\/socket-bounds';$/m);

    const adapter = code(read('collaboration/adapter/collab-ws.adapter.ts'));
    expect(adapter).toMatch(/constructor\(private readonly collabSocketBounds: CollabSocketBounds\)/);
    expect(adapter).toMatch(/verifyClient: collabSocketBounds\.verifyUpgrade/);
    expect(adapter).toMatch(/this\.collabSocketBounds\.holdUpgraded\(ws, socket, request\);/); // #810: the request verifyClient keyed

    const module = code(read('collaboration/collaboration.module.ts'));
    expect(module).toMatch(/^\s*collabSocketBoundsProvider,\s*$/m);
    expect(module).toMatch(/private readonly collabSocketBounds: CollabSocketBounds/);
    expect(module).toMatch(/new CollabWsAdapter\(this\.collabSocketBounds\)/);
    // #810: the bounds' own client trust is what the module exports (never a second CollabClientTrust)
    expect(module).toMatch(/^\s*collabClientTrustProvider,\s*$/m);
    expect(module).toMatch(/exports: \[CollaborationGateway, collabClientTrustProvider\]/);
  });
});
