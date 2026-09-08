import { NotFoundException } from '@nestjs/common';
import { ServiceAttachmentService } from './service-attachment.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') }) as any;
const make = (respond: (q: SpyQuery) => unknown[]) => {
  const spy = spyKysely(respond);
  return { svc: new ServiceAttachmentService(spy.db, workspaces()), spy };
};
const q = (s: string) => s.toLowerCase();

describe('ServiceAttachmentService — page-scoped attachment reads (privileged data plane)', () => {
  it('has NO authorization collaborator: it takes only (db, workspaces)', () => {
    // Same structural proof as ServiceContentService — resolve→page returns metadata, it does not re-authorize.
    expect(ServiceAttachmentService.length).toBe(2);
  });

  it('resolvePage returns the owning page + space, workspace-scoped, excluding soft-deleted', async () => {
    const attachmentId = '11111111-1111-1111-1111-111111111111';
    const { svc, spy } = make(() => [{ pageId: 'pg1', spaceId: 'sp1' }]);
    expect(await svc.resolvePage(attachmentId)).toEqual({ attachmentId, pageId: 'pg1', spaceId: 'sp1' });
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('from attachments');
    expect(sql).toContain('workspace_id =');
    expect(sql).toContain('deleted_at is null');
  });

  it('resolvePage returns null page/space for a non-page attachment (avatar / icon / chat)', async () => {
    const { svc } = make(() => [{ pageId: null, spaceId: null }]);
    expect(await svc.resolvePage('22222222-2222-2222-2222-222222222222')).toEqual({
      attachmentId: '22222222-2222-2222-2222-222222222222',
      pageId: null,
      spaceId: null,
    });
  });

  it('resolvePage 404s an unknown / cross-workspace attachment', async () => {
    const { svc } = make(() => []);
    await expect(
      svc.resolvePage('33333333-3333-3333-3333-333333333333'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listByPage returns the compact projection: file-type only, deleted excluded, numeric fileSize', async () => {
    const pageId = '44444444-4444-4444-4444-444444444444';
    const { svc, spy } = make(() => [
      {
        id: 'a1',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        fileSize: '2048', // int8 arrives as a string from pg; the mapper coerces to number
        type: 'file',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const res = await svc.listByPage(pageId);
    expect(res.items).toEqual([
      { id: 'a1', fileName: 'doc.pdf', mimeType: 'application/pdf', fileSize: 2048, type: 'file', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('from attachments');
    expect(sql).toContain('page_id =');
    expect(sql).toContain('workspace_id =');
    expect(sql).toContain('type ='); // file-type only
    expect(sql).toContain('deleted_at is null');
  });

  it('listByPage coerces a null fileSize to null (not 0)', async () => {
    const { svc } = make(() => [
      { id: 'a2', fileName: 'x', mimeType: null, fileSize: null, type: 'file', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const res = await svc.listByPage('44444444-4444-4444-4444-444444444444');
    expect(res.items[0].fileSize).toBeNull();
  });

  it('listByPage unpaged (no page arg) keeps the legacy query: created_at asc, no keyset, no limit', async () => {
    const { svc, spy } = make(() => []);
    await svc.listByPage('44444444-4444-4444-4444-444444444444');
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('order by created_at asc');
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toContain('limit');
  });

  it('listByPage paged uses the ms-truncated id-tiebroken ascending keyset + limit+1', async () => {
    const { svc, spy } = make(() => []);
    await svc.listByPage('44444444-4444-4444-4444-444444444444', {
      limit: 20,
      before: { createdAt: '2026-01-01T00:00:00.000Z', id: 'a-9' },
    });
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain("date_trunc('milliseconds', created_at) asc");
    expect(sql).toContain('id::text asc');
    expect(sql).toContain('> (');
    expect(call.parameters).toContainEqual(21); // limit + 1
  });
});
