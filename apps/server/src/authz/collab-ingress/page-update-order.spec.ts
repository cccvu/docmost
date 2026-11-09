// PageService's module graph pulls the collab WebSocket stack (lib0 ESM) jest cannot parse; update never touches it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { HttpException } from '@nestjs/common';
import { PageService } from '../../core/page/services/page.service';

/**
 * #781 (ADR 0036), seam #121: native `/api/pages/update` (which `/v1` PATCH relays to) used to write the page row —
 * title, `updatedAt`, `lastUpdatedById`, so the page ETag — BEFORE it parsed the content. A content refusal then
 * answered 400 "not applied" while the title had changed and the caller's next `If-Match` 412'd. The content is now
 * parsed, and refused, before any write, and applied from that one parse.
 */
function service() {
  const calls: string[] = [];
  const s = {
    db: {},
    logger: { warn: jest.fn() },
    pageRepo: {
      updatePage: jest.fn(async () => void calls.push('updatePage')),
      findById: jest.fn(async () => ({ id: 'p1' })),
    },
    generalQueue: { add: jest.fn(async () => void calls.push('watchers')) },
    collaborationGateway: { handleYjsEvent: jest.fn(async () => void calls.push('yjs')) },
  } as Record<string, any>;
  // The REAL parse (and with it the #781 content rules); only its calls are counted.
  s.parseProsemirrorContent = jest.fn(async (content: unknown, format: string) => {
    calls.push('parse');
    return PageService.prototype.parseProsemirrorContent.call(s, content, format);
  });
  s.updatePageContent = PageService.prototype.updatePageContent;
  const update = (dto: Record<string, unknown>) =>
    PageService.prototype.update.call(s, { id: 'p1', contributorIds: [], spaceId: 's', workspaceId: 'w' } as never, { pageId: 'p1', ...dto } as never, { id: 'u' } as never);
  return { s, calls, update };
}

const doc = (marks: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks }] }] });

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('#781 seam #121: PageService.update refuses invalid content BEFORE the row write', () => {
  it.each([
    ['a #781 refusal (a numeric link href)', doc([{ type: 'link', attrs: { href: 7 } }]), { code: 'content_not_allowed' }],
    ['the legacy "Invalid content format"', { type: 'doc', content: [{ type: 'nope-text', text: 1 }, { type: 'text' }] }, { message: 'Invalid content format' }],
  ])('%s: 400, and the title, updatedAt and lastUpdatedById are untouched', async (_name, content, body) => {
    const { s, calls, update } = service();
    const r = await refusal(update({ title: 'RENAMED BY A REFUSED WRITE', content, operation: 'replace', format: 'json' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject(body);
    expect(s.pageRepo.updatePage).not.toHaveBeenCalled();
    expect(calls).toEqual(['parse']);
  });

  it('valid content: parsed ONCE, before the row write, and that parse is what the collab event applies', async () => {
    const { s, calls, update } = service();
    await update({ title: 'Renamed', content: doc([{ type: 'bold' }]), operation: 'replace', format: 'json' });
    expect(calls).toEqual(['parse', 'updatePage', 'watchers', 'yjs']);
    expect(s.collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'updatePageContent',
      'page.p1',
      expect.objectContaining({ prosemirrorJson: doc([{ type: 'bold' }]), operation: 'replace' }),
    );
  });

  it('a metadata-only update parses nothing and still writes the row', async () => {
    const { s, calls, update } = service();
    await update({ title: 'Renamed' });
    expect(calls).toEqual(['updatePage', 'watchers']);
    expect(s.parseProsemirrorContent).not.toHaveBeenCalled();
  });
});
