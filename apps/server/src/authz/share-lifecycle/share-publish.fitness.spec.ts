import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ShareLifecycleModule } from './share-lifecycle.module';
import { SHARE_PUBLISH_ROUTES, SharePublishInterceptor } from './share-publish.interceptor';
import { SharePublishGate } from './share-publish.gate';

/**
 * Share publish gate FITNESS TEST (wiki-v2 #704) — NOT upstream Docmost code.
 *
 * In remote mode, changing a page's publish state needs `page#share` (`SharePublishGate`). The gate is applied by
 * `Controller.handler` key (`SharePublishInterceptor`) and by one direct call (`ShareExpiryController.set`), so it is
 * only as good as that key set and the call graph behind it. This pins, statically (no imports of the real
 * controllers, no boot of the app):
 *  - every share-WIDENING sink, per enclosing METHOD (TS AST, so comments never count): `.createShare(`,
 *    `.updateShare(`, `.insertShare(`, a `shares` row insert / update, and a `ccc_share_expiry` insert / update;
 *  - the routes whose handler reaches one are EXACTLY the gated set, both directions;
 *  - the one `shares` write no gated route makes — `PageService.movePageToSpace` re-pointing `spaceId` — is on a
 *    reasoned keep list, and still writes `spaceId` alone;
 *  - `ShareExpiryController.set` calls the gate after resolving the share and BEFORE its transaction (no row lock is
 *    held across the PDP call);
 *  - ShareLifecycleModule is mounted from AuthzModule, registers this interceptor as its ONE APP_INTERCEPTOR, provides
 *    the gate and its own PDP client, and resolves from the app globals alone.
 * A new path to a sink fails RED, and whoever adds it decides deliberately whether it changes publish state (gate it)
 * or not (keep-list it, with the reason). Deletes are not sinks: removing a share only narrows exposure, and stays
 * edit-only. A static inventory: a sink reached through an unrecognized indirection (a method passed by reference, a
 * dynamic property name) is invisible to it; the meta-guard at the bottom pins the shapes it recognizes.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

/** The fork-owned route that calls the gate itself (not through the interceptor). */
const DIRECT_GATED_ROUTES = ['ShareExpiryController.set'] as const;

/** Text tell that a handler reaches a share-widening sink directly. */
export const SHARE_WIDENING_CALL_RE =
  /\.(?:createShare|updateShare|insertShare)\s*\(|\b(?:insert\s+into|update)\s+"?ccc_share_expiry"?(?![\w"])/i;

// Raw SQL that inserts or updates a `shares` / `ccc_share_expiry` row.
const RAW_SHARES_WRITE_RE = /\b(?:insert\s+into|update)\s+(?:"?public"?\.)?"?shares"?(?![\w"])/i;
const RAW_EXPIRY_WRITE_RE = /\b(?:insert\s+into|update)\s+(?:"?public"?\.)?"?ccc_share_expiry"?(?![\w"])/i;
const SHARES_TABLE_RE = /^shares(?:\s+as\s+\w+)?$/;
const EXPIRY_TABLE_RE = /^ccc_share_expiry(?:\s+as\s+\w+)?$/;

type SinkKind = 'createShareCall' | 'updateShareCall' | 'insertShareCall' | 'sharesRowWrite' | 'expiryRowWrite';

/** Every share-widening sink in one source file, attributed to its enclosing method. Pure; exported for the meta-guard. */
export function scanShareSinks(fileName: string, source: string): Array<{ kind: SinkKind; owner: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ kind: SinkKind; owner: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const owner = ownerOf(node);
      const table = node.arguments[0] ? literalText(node.arguments[0]) ?? '' : '';
      if (name === 'createShare') out.push({ kind: 'createShareCall', owner });
      if (name === 'updateShare') out.push({ kind: 'updateShareCall', owner });
      if (name === 'insertShare') out.push({ kind: 'insertShareCall', owner });
      if ((name === 'insertInto' || name === 'updateTable') && SHARES_TABLE_RE.test(table)) {
        out.push({ kind: 'sharesRowWrite', owner });
      }
      if ((name === 'insertInto' || name === 'updateTable') && EXPIRY_TABLE_RE.test(table)) {
        out.push({ kind: 'expiryRowWrite', owner });
      }
    }
    const text = literalText(node);
    if (text !== undefined && RAW_SHARES_WRITE_RE.test(text)) out.push({ kind: 'sharesRowWrite', owner: ownerOf(node) });
    if (text !== undefined && RAW_EXPIRY_WRITE_RE.test(text)) out.push({ kind: 'expiryRowWrite', owner: ownerOf(node) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, '');

describe('every route that changes publish state goes through the share publish gate (#704)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeKeys = new Set(routes.map(key));
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    return { file, src, sinks: scanShareSinks(file, src) };
  });
  const sitesOf = (kind: SinkKind) =>
    files.flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`)).sort();
  const gated = [...SHARE_PUBLISH_ROUTES.keys(), ...DIRECT_GATED_ROUTES].sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.sinks.length > 0)).toBe(true);
  });

  it('every gated key names a real route', () => {
    expect(gated.filter((k) => !routeKeys.has(k))).toEqual([]);
  });

  it('the gated set is EXACTLY the routes whose handler reaches a share-widening sink', () => {
    const reaching = routes.filter((r) => handlerCalls(r, SHARE_WIDENING_CALL_RE)).map(key).sort();
    expect(reaching).toEqual(gated);
  });

  it('`.createShare(` is called only by the gated create handler', () => {
    expect(sitesOf('createShareCall')).toEqual(['core/share/share.controller.ts:ShareController.create']);
  });

  it('`.updateShare(` is called only by the gated update handler and the service method it calls', () => {
    expect(sitesOf('updateShareCall')).toEqual([
      'core/share/share.controller.ts:ShareController.update',
      'core/share/share.service.ts:ShareService.updateShare',
    ]);
  });

  it('`.insertShare(` is called only by ShareService.createShare and the remote repo override', () => {
    expect(sitesOf('insertShareCall')).toEqual([
      'authz/pdp-share.repo.ts:PdpShareRepo.insertShare',
      'core/share/share.service.ts:ShareService.createShare',
    ]);
  });

  it('every `shares` row insert / update is the repo (behind the gated service) or the KEEP-listed cross-space move', () => {
    expect(sitesOf('sharesRowWrite')).toEqual([
      // KEEP (#704): a cross-space move re-points an EXISTING share's `spaceId` to follow its page. It changes no
      // publish state (no new share, no includeSubPages / searchIndexing / expiry change), and the move route is
      // gated on page edit and the destination space. The share surviving the move is an accepted residual (ADR 0032
      // amendment, #704). Pinned below to write `spaceId` alone.
      'core/page/services/page.service.ts:PageService.movePageToSpace',
      'database/repos/share/share.repo.ts:ShareRepo.insertShare',
      'database/repos/share/share.repo.ts:ShareRepo.updateShare',
    ]);
  });

  it('the KEEP-listed cross-space move writes `spaceId` alone on `shares`', () => {
    const src = files.find((f) => f.file === 'core/page/services/page.service.ts')?.src ?? '';
    const sf = ts.createSourceFile('page.service.ts', src, ts.ScriptTarget.Latest, true);
    const sets: string[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'updateTable' &&
        literalText(n.arguments[0]) === 'shares'
      ) {
        // The `.set(…)` chained directly on `updateTable('shares')`.
        const setAccess = n.parent;
        const setCall = setAccess?.parent;
        if (ts.isPropertyAccessExpression(setAccess) && setAccess.name.text === 'set' && setCall && ts.isCallExpression(setCall)) {
          sets.push(squash(setCall.arguments.map((a) => a.getText(sf)).join(',')));
        } else {
          sets.push('<not a direct .set(...)>');
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(sets).toEqual(['{spaceId:spaceId}']);
  });

  it('every `ccc_share_expiry` insert / update is the gated expiry route or the boot installer (no route)', () => {
    expect(sitesOf('expiryRowWrite')).toEqual([
      'authz/share-lifecycle/share-expiry.controller.ts:ShareExpiryController.set',
      'authz/share-lifecycle/share-expiry.installer.ts:ShareExpiryInstaller.install',
    ]);
    expect(routes.filter((r) => r.controller === 'ShareExpiryInstaller')).toEqual([]);
  });

  it('ShareExpiryController.set calls the gate after resolve() and before any transaction', () => {
    const f = files.find((x) => x.file === 'authz/share-lifecycle/share-expiry.controller.ts')!;
    const sf = ts.createSourceFile(f.file, f.src, ts.ScriptTarget.Latest, true);
    let body: ts.Block | undefined;
    const find = (n: ts.Node) => {
      if (ts.isMethodDeclaration(n) && n.name.getText(sf) === 'set' && ts.isClassLike(n.parent)) body = n.body;
      ts.forEachChild(n, find);
    };
    find(sf);
    const stmts = (body?.statements ?? []).map((s) => squash(s.getText(sf)));
    const at = (needle: string) => stmts.findIndex((s) => s.includes(needle));
    const resolve = at('awaitthis.resolve(dto.shareId,workspace)');
    const gate = at('awaitthis.publishGate.requirePublish(user.id,page);');
    const tx = at('this.bounded(');
    expect(resolve).toBe(0);
    expect(gate).toBe(1);
    expect(tx).toBeGreaterThan(gate);
    expect(stmts.filter((s) => s.includes('requirePublish(')).length).toBe(1);
  });

  it('the gate is injected only into its two entry points', () => {
    const holders = files
      .flatMap((f) => {
        const sf = ts.createSourceFile(f.file, f.src, ts.ScriptTarget.Latest, true);
        const found: string[] = [];
        const visit = (n: ts.Node): void => {
          if (
            ts.isParameter(n) &&
            ts.isConstructorDeclaration(n.parent) &&
            n.type &&
            ts.isTypeReferenceNode(n.type) &&
            n.type.typeName.getText(sf) === 'SharePublishGate'
          ) {
            found.push(`${f.file}:${ownerOf(n).replace(/\.constructor$/, '')}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return found;
      })
      .sort();
    expect(holders).toEqual([
      'authz/share-lifecycle/share-expiry.controller.ts:ShareExpiryController',
      'authz/share-lifecycle/share-publish.interceptor.ts:SharePublishInterceptor',
    ]);
  });

  describe('wiring', () => {
    it('AuthzModule imports ShareLifecycleModule (read from its @Module decorator, not a comment)', () => {
      const src = files.find((f) => f.file === 'authz/authz.module.ts')?.src ?? '';
      expect(moduleImports('authz/authz.module.ts', src)).toContain('ShareLifecycleModule');
    });

    it('ShareLifecycleModule registers the publish interceptor as its ONE APP_INTERCEPTOR, with the gate and a local PDP client', () => {
      const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ShareLifecycleModule) ?? []) as Array<{
        provide?: unknown;
        useClass?: unknown;
      }>;
      expect(providers.filter((p) => p?.provide === APP_INTERCEPTOR).map((p) => p.useClass)).toEqual([
        SharePublishInterceptor,
      ]);
      expect(providers).toEqual(expect.arrayContaining([SharePublishGate, HttpAuthzClient]));
      expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ShareLifecycleModule) ?? []).toEqual([]);
    });

    it('SharePublishInterceptor is registered nowhere else', () => {
      const elsewhere = files
        .filter(
          (f) =>
            f.file !== 'authz/share-lifecycle/share-lifecycle.module.ts' &&
            f.file !== 'authz/share-lifecycle/share-publish.interceptor.ts',
        )
        .filter((f) => referencesIdentifier(f.file, f.src, 'SharePublishInterceptor'))
        .map((f) => f.file);
      expect(elsewhere).toEqual([]);
    });

    it('resolves from the app globals plus its own PDP client (an unresolvable dependency fails here, not at boot)', async () => {
      @Global()
      @Module({
        providers: [
          { provide: AUTHZ_MODE, useValue: 'native' },
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: {} },
          { provide: ShareRepo, useValue: {} },
          { provide: PageRepo, useValue: {} },
          { provide: PageAccessService, useValue: {} },
          { provide: AUDIT_SERVICE, useValue: {} },
          { provide: EnvironmentService, useValue: {} }, // JwtAuthGuard's (the expiry controller's @UseGuards)
        ],
        exports: [
          AUTHZ_MODE,
          KYSELY_MODULE_CONNECTION_TOKEN(),
          ShareRepo,
          PageRepo,
          PageAccessService,
          AUDIT_SERVICE,
          EnvironmentService,
        ],
      })
      class AppGlobalsStub {}
      const moduleRef = await Test.createTestingModule({ imports: [AppGlobalsStub, ShareLifecycleModule] }).compile();
      expect(moduleRef.get(SharePublishGate)).toBeInstanceOf(SharePublishGate);
      expect(moduleRef.get(HttpAuthzClient)).toBeInstanceOf(HttpAuthzClient);
      await moduleRef.close();
    });
  });
});

/** True when `name` appears as an identifier in code (comments and strings are ignored). */
function referencesIdentifier(file: string, src: string, name: string): boolean {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The identifiers in the `imports: [...]` of the `@Module({...})` decorators in a file. */
function moduleImports(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isDecorator(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Module'
    ) {
      const arg = node.expression.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'imports' &&
            ts.isArrayLiteralExpression(p.initializer)
          ) {
            for (const el of p.initializer.elements) if (ts.isIdentifier(el)) names.push(el.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// The inventory is only as strong as the shapes the scanner recognizes. Pin them so a later edit cannot quietly
// narrow detection.
describe('the share-widening sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string) => scanShareSinks('probe.ts', src).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { w() { return this.db.insertInto('shares').values(v).execute(); } }`, 'sharesRowWrite@R.w'],
    [`class R { w() { return dbOrTx(this.db, trx).updateTable("shares").set(v).execute(); } }`, 'sharesRowWrite@R.w'],
    ['class R { w(id) { return sql`UPDATE shares SET include_sub_pages = true WHERE id = ${id}`.execute(this.db); } }', 'sharesRowWrite@R.w'],
    [`class R { w() { return this.pg.query('insert into "shares" (key) values ($1)'); } }`, 'sharesRowWrite@R.w'],
    ['class R { w(id) { return sql`insert into ccc_share_expiry (share_id) values (${id})`; } }', 'expiryRowWrite@R.w'],
    ['class R { w(id) { return sql`update ccc_share_expiry set expires_at = null where share_id = ${id}`; } }', 'expiryRowWrite@R.w'],
    [`class R { w() { return this.db.updateTable('ccc_share_expiry').set(v).execute(); } }`, 'expiryRowWrite@R.w'],
    [`class C { h() { return this.shareService.createShare(o); } }`, 'createShareCall@C.h'],
    [`class C { h() { return this.shareService.updateShare(id, dto); } }`, 'updateShareCall@C.h'],
    [`class R extends B { insertShare(v, t) { return super.insertShare(v, t); } }`, 'insertShareCall@R.insertShare'],
  ])('flags %s', (src, expected) => {
    expect(kinds(src)).toEqual([expected]);
  });

  it.each([
    [`class R { d() { return this.db.deleteFrom('shares').execute(); } }`],
    ['class R { d(id) { return sql`delete from shares where id = ${id}`; } }'],
    [`class R { r() { return this.db.selectFrom('shares').selectAll().execute(); } }`],
    [`class R { w() { return this.db.updateTable('shares_archive').set(v).execute(); } }`],
    [`const t = 'select 1 from ccc_share_expiry cse';`],
    [`// this.shareService.createShare(o)\n/* sql\`update shares set x = 1\` */ const x = 1;`],
    [`class S { createShare(o) { return 1; } }`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it('attributes each call to its enclosing method, so a NEW caller in a listed file is caught', () => {
    const src = `class ShareController {
      create() { return this.shareService.createShare(o); }
      bulkPublish() { return this.shareService.createShare(o); }
    }`;
    expect(kinds(src)).toEqual(['createShareCall@ShareController.create', 'createShareCall@ShareController.bulkPublish']);
  });

  it('the route tell sees each sink and not a declaration, a read or a delete', () => {
    expect(SHARE_WIDENING_CALL_RE.test('this.shareService.createShare({ page })')).toBe(true);
    expect(SHARE_WIDENING_CALL_RE.test('this.shareService.updateShare(share.id, dto)')).toBe(true);
    expect(SHARE_WIDENING_CALL_RE.test('this.repo.insertShare(v)')).toBe(true);
    expect(SHARE_WIDENING_CALL_RE.test('insert into ccc_share_expiry (share_id, expires_at, updated_at)')).toBe(true);
    expect(SHARE_WIDENING_CALL_RE.test('async create(@Body() dto: CreateShareDto) {}')).toBe(false);
    expect(SHARE_WIDENING_CALL_RE.test('this.shareRepo.deleteShare(share.id)')).toBe(false);
    expect(SHARE_WIDENING_CALL_RE.test('select 1 from ccc_share_expiry')).toBe(false);
  });
});
