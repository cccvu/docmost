// collaboration.util pulls tiptap/yjs (lib0 ESM) that jest cannot load; the extension only needs getPageId.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (name: string) => name.split('.')[1],
}));

import * as postgres from 'postgres';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { decode } from 'jsonwebtoken';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { TokenService } from '../../core/auth/services/token.service';
import { SessionService } from '../../core/session/session.service';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { CollabSocketBounds } from '../collab-ingress/socket-bounds';
import {
  PG_URL,
  bootstrapSchema,
  createReadModelTables,
  mkReadModelDb,
  mkReadModelPg,
  uuid,
} from '../../service-bridge/read-model-pg.testkit';

/**
 * The collab token is bound to a live session, on a REAL Postgres (wiki-v2 #537) — NOT upstream Docmost code.
 *
 * The whole path with the REAL upstream `SessionService.createSessionAndToken`, `TokenService`, `UserRepo`,
 * `UserSessionRepo` and `AuthenticationExtension` (page and permission checks stubbed to allow): sign in → mint a
 * collab token from the access token's session → connect. The property: the collab connect honors the session row
 * exactly as `/api` does. Sign-out (revoke) or expiry of THAT session refuses it; the user's other session is
 * untouched; a deactivated user is refused.
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz` lane); the `docmost-authz-pg` lane sets
 * AUTHZ_REQUIRE_PG=1 so the anti-vacuity guard reds if that wiring regresses.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG collab session binding lane (#537)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'collab_session_bound_pg_spec';
const WS = uuid(100);
const SECRET = 'collab-session-bound-pg-spec';

d('the collab connect re-checks the collab token session on real Postgres (#537)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let tokens: TokenService;
  let sessions: SessionService;
  let userRepo: UserRepo;
  let ext: AuthenticationExtension;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    const db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    await pg`
      create table users (
        id uuid primary key default gen_random_uuid(),
        name varchar, email varchar not null, email_verified_at timestamptz, avatar_url varchar,
        password varchar, role varchar, workspace_id uuid references workspaces(id) on delete cascade,
        locale varchar, timezone varchar, settings jsonb, last_login_at timestamptz,
        deactivated_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, has_generated_password boolean not null default false,
        constraint users_email_workspace_id_unique unique (email, workspace_id)
      )`;
    // Faithful to the user_sessions migration (20260326T121350).
    await pg`
      create table user_sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null, workspace_id uuid not null, device_name varchar, user_agent varchar,
        ip_address inet, geo_location varchar, metadata jsonb,
        last_active_at timestamptz not null default now(), expires_at timestamptz not null,
        revoked_at timestamptz, created_at timestamptz not null default now()
      )`;
    await pg`insert into workspaces (id, name) values (${WS}, 'default')`;

    const userSessionRepo = new UserSessionRepo(db as any);
    userRepo = new UserRepo(db as any);
    const env = {
      getCookieExpiresIn: () => new Date(Date.now() + 30 * 86_400_000),
      getAppSecret: () => SECRET,
    } as any;
    tokens = new TokenService(new JwtService({ secret: SECRET }), env);
    const cls = { get: () => undefined, set: () => undefined } as any;
    sessions = new SessionService(tokens, userSessionRepo, env, cls);
    ext = new AuthenticationExtension(
      tokens,
      userRepo,
      { findById: async (id: string) => ({ id, spaceId: 's1', deletedAt: null }) } as any,
      { getUserSpaceRoles: async (userId: string) => [{ userId, role: 'writer' }] } as any,
      { canUserEditPage: async () => ({ hasAnyRestriction: false, canAccess: true, canEdit: true }) } as any,
      userSessionRepo,
      new CollabSocketBounds(),
    );
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 }).catch(() => undefined);
    await pg?.end({ timeout: 5 }).catch(() => undefined);
  });

  const newUser = async (email: string) => {
    const [row] = (await pg`
      insert into users (email, workspace_id) values (${email}, ${WS}) returning id`) as unknown as Array<{ id: string }>;
    return userRepo.findById(row.id, WS);
  };

  /** Sign in (the real session mint) and fetch a collab token for that session, as POST /api/auth/collab-token does. */
  const signIn = async (user: any) => {
    const access = await sessions.createSessionAndToken(user);
    const sessionId = (decode(access, { json: true }) as { sessionId: string }).sessionId;
    const collab = await tokens.generateCollabToken(user, WS, sessionId);
    return { sessionId, collab };
  };

  const connect = (token: string) =>
    ext.onAuthenticate({ documentName: 'page.p1', token, connectionConfig: { readOnly: false } } as any);

  it('a collab token from a live session connects', async () => {
    const alice = await newUser('alice@pg537');
    const { collab } = await signIn(alice);
    await expect(connect(collab)).resolves.toEqual({ user: expect.objectContaining({ id: alice.id }) });
  });

  it("after sign-out (the session revoked) it is refused, while the user's other session still connects", async () => {
    const bob = await newUser('bob@pg537');
    const first = await signIn(bob);
    const second = await signIn(bob);
    await expect(connect(first.collab)).resolves.toBeDefined();

    await sessions.revokeSession(first.sessionId, bob.id, WS);

    await expect(connect(first.collab)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(connect(second.collab)).resolves.toEqual({ user: expect.objectContaining({ id: bob.id }) });
  });

  it('a session past expires_at is refused', async () => {
    const carol = await newUser('carol@pg537');
    const { sessionId, collab } = await signIn(carol);
    await pg`update user_sessions set expires_at = now() - interval '1 minute' where id = ${sessionId}`;
    await expect(connect(collab)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a deactivated user is refused even with a live session', async () => {
    const dave = await newUser('dave@pg537');
    const { sessionId, collab } = await signIn(dave);
    await pg`update users set deactivated_at = now() where id = ${dave.id}`;
    const [row] = (await pg`select revoked_at from user_sessions where id = ${sessionId}`) as unknown as Array<{
      revoked_at: Date | null;
    }>;
    expect(row.revoked_at).toBeNull(); // the session row is live: the user check alone refuses
    await expect(connect(collab)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
