import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema, type ContentMatch, type NodeType } from '@tiptap/pm/model';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { generateHTML } from '../../common/helpers/prosemirror/html';
import { serverSchema } from '../page-write/prelim-content';
import { ALL_NODES_DOC } from './collab-ingress.testkit';
import { attrNames, STRING_ATTRS } from './content-rules';

/**
 * #781 drift guards (ADR 0036). The collab update guard and its HTTP twin take the editor schema as the acceptance test,
 * plus a few hand-kept tables. Each table is pinned here so a schema change cannot silently weaken the guard:
 *   - the server's node and mark names equal a committed snapshot (the client parity test holds the editor to it);
 *   - every renderer that crashes on a non-string attribute is in STRING_ATTRS (KNOWN_THROWS of the render-gate spec,
 *     and a live sweep of the server renderers), and every STRING_ATTRS entry names a real attribute;
 *   - every mark excludes itself (a hashed `<mark>--<hash>` key is then never honest, so the guard refuses it);
 *   - the empty-container exemption cannot cascade into a loss (see the cascade describe);
 *   - the false-positive fixture holds every node and mark.
 */
const schema = serverSchema();
const snapshot: { nodes: string[]; marks: string[] } = JSON.parse(readFileSync(join(__dirname, 'schema-names.snapshot.json'), 'utf8'));
const names = (o: Record<string, unknown>) => Object.keys(o).sort();

describe('#781 schema names = the committed snapshot', () => {
  it('nodes and marks', () => {
    expect({ nodes: names(schema.nodes), marks: names(schema.marks) }).toEqual({ nodes: snapshot.nodes, marks: snapshot.marks });
  });

  it('every mark excludes itself (so no honest client writes a hashed mark key)', () => {
    for (const mark of Object.values(schema.marks)) expect([mark.name, mark.excludes(mark)]).toEqual([mark.name, true]);
  });

  it('the false-positive fixture holds every node and mark of the schema', () => {
    const seen = { nodes: new Set<string>(['doc']), marks: new Set<string>() };
    const stack: any[] = [ALL_NODES_DOC];
    while (stack.length) {
      const n = stack.pop();
      seen.nodes.add(n.type);
      for (const m of n.marks ?? []) seen.marks.add(m.type);
      stack.push(...(n.content ?? []));
    }
    expect([...seen.nodes].sort()).toEqual(snapshot.nodes);
    expect([...seen.marks].sort()).toEqual(snapshot.marks);
  });
});

describe('#781 STRING_ATTRS covers every renderer that crashes on a non-string value', () => {
  it('every entry names a real attribute of a real node or mark', () => {
    for (const entry of STRING_ATTRS) {
      const [kind, rest] = entry.split(' ');
      const [type, attr] = rest.split('.');
      const spec = kind === 'mark' ? schema.marks[type] : kind === 'node' ? schema.nodes[type] : undefined;
      expect([entry, !!spec && attrNames(spec).includes(attr)]).toEqual([entry, true]);
    }
  });

  it("the render-gate spec's KNOWN_THROWS ⊆ STRING_ATTRS", () => {
    const source = readFileSync(join(__dirname, '../../editor-compat/render-gate.fitness.spec.ts'), 'utf8');
    const block = /const KNOWN_THROWS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1];
    expect(block).toBeDefined();
    const known = [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(known.length).toBeGreaterThanOrEqual(10);
    expect(known.filter((k) => !STRING_ATTRS.has(k))).toEqual([]);
  });

  it('a live sweep of the server renderers finds no other crash', () => {
    const BASE: Record<string, Record<string, unknown>> = { youtube: { src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } };
    const place = (type: string, attrs: Record<string, unknown>) => {
      const node = { type, attrs, content: [{ type: 'paragraph' }] as unknown[] };
      if (type === 'tableCell' || type === 'tableHeader') return { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [node] }] }] };
      if (type === 'tableRow') return { type: 'doc', content: [{ type: 'table', content: [{ ...node, content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }] }] };
      return { type: 'doc', content: [{ type, attrs }] };
    };
    const throwing: string[] = [];
    let rendered = 0;
    const tryRender = (label: string, json: unknown) => {
      try {
        generateHTML(json as never, tiptapExtensions);
        rendered++;
      } catch {
        throwing.push(label);
      }
    };
    for (const [type, nodeType] of Object.entries(schema.nodes)) {
      if (type === 'doc' || type === 'text') continue;
      for (const attr of attrNames(nodeType)) {
        for (const bad of [{ x: 1 }, 7]) tryRender(`node ${type}.${attr}`, place(type, { ...BASE[type], [attr]: bad }));
      }
    }
    for (const [type, markType] of Object.entries(schema.marks)) {
      for (const attr of attrNames(markType)) {
        for (const bad of [{ x: 1 }, 7]) {
          tryRender(`mark ${type}.${attr}`, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type, attrs: { [attr]: bad } }] }] }] });
        }
      }
    }
    expect(rendered).toBeGreaterThan(100); // anti-vacuity: the sweep really rendered
    expect([...new Set(throwing)].filter((k) => !STRING_ATTRS.has(k))).toEqual([]);
  });
});

/**
 * The guard lets an element become EMPTY even when its schema needs content (the honest concurrent-delete race); every
 * browser's y-tiptap then deletes the empty element, which loses no text. That is only safe while removing such an
 * element never invalidates a NON-EMPTY parent: otherwise y-tiptap would delete the parent, and its text with it.
 * This proves the property on the content automata (exactly, not by sampling): for every parent P and every
 * required-content N that P admits, removing one N from any valid child list of P leaves it valid or empty.
 */
function removalViolations(s: Schema): string[] {
  const required = Object.values(s.nodes).filter((n) => !n.contentMatch.validEnd && n !== s.topNodeType);
  const out: string[] = [];
  const edges = (m: ContentMatch) => Array.from({ length: m.edgeCount }, (_, i) => m.edge(i));
  for (const parent of Object.values(s.nodes)) {
    const start = parent.contentMatch;
    // States reachable after at least one child (a non-empty prefix).
    const afterSome = new Set<ContentMatch>();
    const queue = edges(start).map((e) => e.next);
    while (queue.length) {
      const m = queue.pop()!;
      if (afterSome.has(m)) continue;
      afterSome.add(m);
      queue.push(...edges(m).map((e) => e.next));
    }
    for (const a of [start, ...afterSome]) {
      for (const { type: n, next: b } of edges(a)) {
        if (!required.includes(n as NodeType)) continue;
        // Run every suffix from B (with the N) and from A (without it) in lockstep.
        const seen = new Set<string>();
        const pairs: Array<[ContentMatch | null, ContentMatch, boolean]> = [[a, b, true]];
        const ids = new Map<ContentMatch, number>();
        const id = (m: ContentMatch | null) => (m ? (ids.get(m) ?? (ids.set(m, ids.size), ids.size - 1)) : -1);
        while (pairs.length) {
          const [x, y, suffixEmpty] = pairs.pop()!;
          const key = `${id(x)}:${id(y)}:${suffixEmpty}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const emptyAfterRemoval = suffixEmpty && a === start && !afterSome.has(start);
          if (y.validEnd && !x?.validEnd && !emptyAfterRemoval) {
            out.push(`${parent.name}: removing a ${n.name} can leave it invalid and non-empty`);
            break;
          }
          for (const e of edges(y)) pairs.push([x ? x.matchType(e.type) : null, e.next, false]);
        }
      }
    }
  }
  return [...new Set(out)];
}

describe('#781 the empty-container exemption never cascades into a loss', () => {
  it('holds for every required-content type of the server schema', () => {
    expect(removalViolations(schema)).toEqual([]);
  });

  it('anti-vacuity: a schema whose pair needs a non-empty body is caught', () => {
    const bad = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'text*' },
        head: { content: 'text*' },
        body: { content: 'paragraph+' },
        pair: { group: 'block', content: 'head body' },
        text: {},
      },
    });
    expect(removalViolations(bad)).toEqual(['pair: removing a body can leave it invalid and non-empty']);
  });
});
