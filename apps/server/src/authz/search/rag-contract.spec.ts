import * as fs from 'fs';
import * as path from 'path';

/**
 * CCC authorization integration test (fork compatibility suite) — the RAG/retrieval contract fitness
 * function (ADR 0005). Filter-then-retrieve is the ONLY retrieval path: the authorized page-id set gates
 * retrieval BEFORE any top-k/limit is truncated, for search AND for a future vector/`page_embeddings`
 * path. There is no vector retrieval in this repo today (EE-gated, empty ee/, no table, no processor), so
 * this test guards the FUTURE: if a pgvector similarity query or a `page_embeddings` read is added
 * anywhere in the fork WITHOUT routing its candidates through the authorized-set gate
 * (`filterAccessiblePageIds` / `collectAuthorized` / `AuthorizedObjects`), the build fails here.
 */

const SRC = path.resolve(__dirname, '../../'); // apps/server/src

// Signals of a vector/semantic retrieval query. The reliable one is a read of the embeddings table; the
// pgvector-specific operators/functions are secondary (plain `<->` is intentionally omitted — it also
// denotes trigram/range distance and would false-positive on non-vector SQL).
const VECTOR_QUERY: RegExp[] = [
  /(selectFrom|\.from)\(\s*['"](page_embeddings|pageEmbeddings)['"]/,
  /<=>/, // pgvector cosine distance
  /<#>/, // pgvector negative inner product
  /\b(cosine_distance|l2_distance|inner_product)\b/,
];

const GATE = /filterAccessiblePageIds|collectAuthorized|AuthorizedObjects/;

// Files that reference embeddings for non-retrieval reasons (type defs, an existence check, queue names).
const BENIGN = new Set<string>([
  'database/types/embeddings.types.ts',
  'database/helpers/helpers.ts',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'ee') continue;
      out.push(...walk(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('RAG/retrieval contract (ADR 0005) — filter-then-retrieve is the only retrieval path', () => {
  const files = walk(SRC);

  it('the search retrieval gate is actually wired (PdpSearchService uses filterAccessiblePageIds)', () => {
    const svc = fs.readFileSync(
      path.join(SRC, 'authz/search/pdp-search.service.ts'),
      'utf8',
    );
    expect(svc).toMatch(/filterAccessiblePageIds/);
  });

  it('no vector / page_embeddings retrieval exists outside the authorized-set gate', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (BENIGN.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (VECTOR_QUERY.some((re) => re.test(src)) && !GATE.test(src)) {
        offenders.push(rel);
      }
    }
    // Empty today (no vector path). If this ever fails, a similarity/embeddings query was added without
    // gating its candidates through filterAccessiblePageIds BEFORE top-k. See ADR 0005 / CLAUDE.md P0.
    expect(offenders).toEqual([]);
  });
});
