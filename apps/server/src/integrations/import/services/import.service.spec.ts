import { PayloadTooLargeException } from '@nestjs/common';
import { Readable } from 'stream';

// `import.service` statically imports `import-formatter`, which pulls the ESM-only `@sindresorhus/slugify`
// that jest's `transformIgnorePatterns` does not transform. Stub it — the truncation guard runs before any
// formatter function is used, so this only removes a load-time ESM parse from the graph.
jest.mock('../utils/import-formatter', () => ({}));

import { ImportService } from './import.service';

/**
 * CCC #308 (import sibling): the zip-import path had the same silent-truncation bug as attachment
 * upload — `createByteCountingStream` + `getBytesRead()` recorded the post-truncation byte count and
 * a `fileTasks` row was created for a truncated archive. The fix fails CLOSED: on `.truncated` it
 * deletes the partial object and throws 413 before the row insert or the import job is queued.
 */
describe('ImportService — #308 oversize import fails closed (413), never truncate-and-succeed', () => {
  function truncatedZip() {
    const stream = Readable.from([Buffer.alloc(16)]) as Readable & { truncated?: boolean };
    stream.truncated = true;
    return { filename: 'import.zip', file: stream };
  }

  it('deletes the partial object and throws PayloadTooLargeException; no fileTasks row, no import job', async () => {
    const storageService = {
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const db = { insertInto: jest.fn() }; // must NOT be reached
    const fileTaskQueue = { add: jest.fn() }; // must NOT be reached
    const service = new ImportService(
      {} as any, // pageRepo
      storageService as any,
      db as any,
      fileTaskQueue as any,
      {} as any, // moduleRef
    );

    await expect(
      service.importZip(
        Promise.resolve(truncatedZip() as any),
        'generic',
        'user-1',
        'space-1',
        'ws-1',
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    expect(storageService.delete).toHaveBeenCalledTimes(1);
    expect(db.insertInto).not.toHaveBeenCalled();
    expect(fileTaskQueue.add).not.toHaveBeenCalled();
  });
});
