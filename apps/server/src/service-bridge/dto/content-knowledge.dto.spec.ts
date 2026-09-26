import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContentAncestorsDto, ContentListDto, SpaceCommentPolicyDto } from './content-read.dto';
import { ContentLabelListDto } from './content-labels.dto';
import { ACTIVITY_TYPES, ContentActivityListDto } from './content-activity.dto';

/**
 * #615 — the class-validator decorators on the new / extended content-read DTOs are the load-bearing input guard
 * (the global ValidationPipe enforces them at the edge; the service and pg specs call the service directly and never
 * run them). Run each DTO through `plainToInstance` + `validate()` exactly as the pipe does, so a dropped constraint
 * — or a dropped label-name normalization — fails a test.
 */
const errCount = async <T extends object>(cls: new () => T, obj: unknown): Promise<number> =>
  (await validate(plainToInstance(cls, obj as any))).length;

const UUID = '00000000-0000-4000-8000-000000000001';
const LIST = { ids: [UUID], limit: 10 };

describe('#615 content-read DTO validation', () => {
  describe('ContentListDto — the new page filters', () => {
    it('accepts every new filter in range, and the position sort', async () => {
      expect(
        await errCount(ContentListDto, {
          ...LIST,
          topLevel: false,
          lastUpdatedById: UUID,
          createdSince: '2026-01-01T00:00:00.000Z',
          createdUntil: '2026-02-01T00:00:00.000Z',
          labelName: 'road-map',
          linksTo: UUID,
          sort: { field: 'position', direction: 'asc' },
        }),
      ).toBe(0);
      expect(await errCount(ContentListDto, { ...LIST, descendantOf: UUID, maxDepth: 1 })).toBe(0);
      expect(await errCount(ContentListDto, { ...LIST, descendantOf: UUID, maxDepth: 10 })).toBe(0);
      expect(await errCount(ContentListDto, { ...LIST, linkedFrom: UUID })).toBe(0);
    });

    it('rejects a non-boolean topLevel, non-uuid ids, and a maxDepth outside 1..10', async () => {
      expect(await errCount(ContentListDto, { ...LIST, topLevel: 'true' })).toBeGreaterThan(0);
      for (const k of ['descendantOf', 'linksTo', 'linkedFrom', 'lastUpdatedById']) {
        expect(await errCount(ContentListDto, { ...LIST, [k]: 'nope' })).toBeGreaterThan(0);
      }
      for (const maxDepth of [0, 11, 1.5]) {
        expect(await errCount(ContentListDto, { ...LIST, descendantOf: UUID, maxDepth })).toBeGreaterThan(0);
      }
      expect(await errCount(ContentListDto, { ...LIST, createdSince: 'yesterday' })).toBeGreaterThan(0);
    });

    it('normalizes labelName as Docmost stores label names, then enforces its charset and length', async () => {
      expect(plainToInstance(ContentListDto, { ...LIST, labelName: '  Road   Map ' }).labelName).toBe('road-map');
      expect(await errCount(ContentListDto, { ...LIST, labelName: '  Road Map ' })).toBe(0);
      expect(await errCount(ContentListDto, { ...LIST, labelName: 'a~b' })).toBe(0);
      for (const labelName of ['~leading-tilde', 'a%b', 'a/b', '   ', 'a'.repeat(101), 42]) {
        expect(await errCount(ContentListDto, { ...LIST, labelName })).toBeGreaterThan(0);
      }
    });

    it('rejects a sort field outside the allowlist (position is in it)', async () => {
      expect(await errCount(ContentListDto, { ...LIST, sort: { field: 'slug', direction: 'asc' } })).toBeGreaterThan(0);
    });
  });

  describe('ContentAncestorsDto / SpaceCommentPolicyDto', () => {
    it('require one uuid', async () => {
      expect(await errCount(ContentAncestorsDto, { pageId: UUID })).toBe(0);
      expect(await errCount(ContentAncestorsDto, {})).toBeGreaterThan(0);
      expect(await errCount(ContentAncestorsDto, { pageId: 'nope' })).toBeGreaterThan(0);
      expect(await errCount(SpaceCommentPolicyDto, { spaceId: UUID })).toBe(0);
      expect(await errCount(SpaceCommentPolicyDto, {})).toBeGreaterThan(0);
      expect(await errCount(SpaceCommentPolicyDto, { spaceId: 'nope' })).toBeGreaterThan(0);
    });
  });

  describe('ContentLabelListDto', () => {
    it('accepts an id set (empty included), a normalized substring and a name cursor', async () => {
      expect(await errCount(ContentLabelListDto, { ids: [], limit: 1 })).toBe(0);
      expect(
        await errCount(ContentLabelListDto, { ...LIST, spaceId: UUID, nameContains: 'Road Map', before: { name: 'alpha' } }),
      ).toBe(0);
      expect(plainToInstance(ContentLabelListDto, { ...LIST, nameContains: ' Road Map' }).nameContains).toBe('road-map');
    });

    it('rejects a missing / over-cap id set, an out-of-range limit, a blank or over-long substring, a bad cursor', async () => {
      expect(await errCount(ContentLabelListDto, { limit: 10 })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ids: Array.from({ length: 10001 }, () => UUID), limit: 10 })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ids: ['nope'], limit: 10 })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ids: [UUID], limit: 0 })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ids: [UUID], limit: 101 })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ...LIST, nameContains: '   ' })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ...LIST, nameContains: 'a'.repeat(101) })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ...LIST, before: {} })).toBeGreaterThan(0);
      expect(await errCount(ContentLabelListDto, { ...LIST, before: { name: 'a'.repeat(101) } })).toBeGreaterThan(0);
    });
  });

  describe('ContentActivityListDto', () => {
    const ACT = { ids: [UUID], since: '2026-01-01T00:00:00.000Z', limit: 10 };

    it('accepts the full filter set and every allowlisted type', async () => {
      expect(
        await errCount(ContentActivityListDto, {
          ...ACT,
          spaceId: UUID,
          pageId: UUID,
          until: '2026-02-01T00:00:00.000Z',
          types: [...ACTIVITY_TYPES],
          actorId: UUID,
          before: { occurredAt: '2026-01-15T00:00:00.000Z', key: `h:${UUID}` },
        }),
      ).toBe(0);
    });

    it('requires since, and rejects a bad instant, type, actor, cursor or limit', async () => {
      expect(await errCount(ContentActivityListDto, { ids: [UUID], limit: 10 })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, since: 'last week' })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, until: 'soon' })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, types: [] })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, types: ['page.viewed'] })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, types: [...ACTIVITY_TYPES, 'page.created'] })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, actorId: 'nope' })).toBeGreaterThan(0);
      for (const key of [`x:${UUID}`, 'h:ABCDEF00-0000-4000-8000-000000000001', 'h:', `h:${UUID}' or 1=1`]) {
        expect(
          await errCount(ContentActivityListDto, { ...ACT, before: { occurredAt: '2026-01-15T00:00:00.000Z', key } }),
        ).toBeGreaterThan(0);
      }
      expect(await errCount(ContentActivityListDto, { ...ACT, before: { key: `h:${UUID}` } })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, limit: 101 })).toBeGreaterThan(0);
      expect(await errCount(ContentActivityListDto, { ...ACT, ids: Array.from({ length: 10001 }, () => UUID) })).toBeGreaterThan(0);
    });
  });
});
