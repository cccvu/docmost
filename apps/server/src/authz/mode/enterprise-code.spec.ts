import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  assertNoEnterpriseCode,
  ENTERPRISE_CODE_DIR,
  enterpriseCodePresent,
} from './enterprise-code';

/**
 * CCC authorization integration test — NOT upstream Docmost code (wiki-v2 #133, ADR 0035).
 *
 * The boot refusal for Docmost EE code. A truth table over real temp directories, plus two pins on the REAL
 * checkout: the default directory is the one `app.module.ts`'s `require('./ee/ee.module')` reads, and it is
 * empty here, so an initialized `src/ee` gitlink reds CI before it can boot anywhere.
 */
describe('enterprise-code boot refusal (#133)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ccc-ee-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const absentCases: Array<[string, () => string]> = [
    ['the directory does not exist (ENOENT)', () => path.join(root, 'ee')],
    [
      'the directory is empty',
      () => {
        const d = path.join(root, 'ee');
        mkdirSync(d);
        return d;
      },
    ],
    [
      'the directory holds only dotfiles (.git, .gitkeep)',
      () => {
        const d = path.join(root, 'ee');
        mkdirSync(d);
        writeFileSync(path.join(d, '.git'), 'gitdir: ../../.git/modules/ee\n');
        writeFileSync(path.join(d, '.gitkeep'), '');
        return d;
      },
    ],
  ];

  it.each(absentCases)('absent → boots: %s', (_name, make) => {
    const dir = make();
    expect(enterpriseCodePresent(dir)).toBe(false);
    expect(() => assertNoEnterpriseCode(dir)).not.toThrow();
  });

  const presentCases: Array<[string, () => string]> = [
    [
      'a regular file (ee.module.js)',
      () => {
        const d = path.join(root, 'ee');
        mkdirSync(d);
        writeFileSync(path.join(d, 'ee.module.js'), 'module.exports = {};');
        return d;
      },
    ],
    [
      'a subdirectory (api-key/)',
      () => {
        const d = path.join(root, 'ee');
        mkdirSync(path.join(d, 'api-key'), { recursive: true });
        return d;
      },
    ],
    [
      'a non-ENOENT error: the path is a regular file (ENOTDIR) — fail closed',
      () => {
        const d = path.join(root, 'ee');
        writeFileSync(d, 'not a directory');
        return d;
      },
    ],
  ];

  it.each(presentCases)('present → refuses to boot: %s', (_name, make) => {
    const dir = make();
    expect(enterpriseCodePresent(dir)).toBe(true);
    expect(() => assertNoEnterpriseCode(dir)).toThrow(/ADR 0035/);
    expect(() => assertNoEnterpriseCode(dir)).toThrow(/every AUTHZ_MODE/);
  });

  it('the default directory is the one app.module.ts requires `./ee/ee.module` from', () => {
    // Path math only: requiring app.module would boot half the app. app.module.ts sits two levels above this
    // file's directory (src/authz/mode → src), in ts/jest and (as dist/authz/mode → dist) in the build.
    const appModuleDir = path.resolve(__dirname, '../..');
    expect(path.basename(path.join(appModuleDir, 'app.module.ts'))).toBe(
      'app.module.ts',
    );
    expect(existsSync(path.join(appModuleDir, 'app.module.ts'))).toBe(true);
    expect(ENTERPRISE_CODE_DIR).toBe(path.join(appModuleDir, 'ee'));
  });

  it('the REAL checkout has no EE code (an initialized src/ee gitlink reds here)', () => {
    expect(enterpriseCodePresent(ENTERPRISE_CODE_DIR)).toBe(false);
    expect(() => assertNoEnterpriseCode()).not.toThrow();
  });
});
