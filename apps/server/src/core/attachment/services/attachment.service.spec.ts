import { PayloadTooLargeException } from '@nestjs/common';
import { Readable } from 'stream';
import { AttachmentService } from './attachment.service';

/**
 * CCC #308 regression: an oversize upload is TRUNCATED by @fastify/multipart at the `fileSize` cap
 * (busboy sets `file.truncated = true` and ends the stream cleanly, without erroring it). Before the
 * fix, `uploadFile` recorded `fileSize = getBytesRead()` (the truncated byte count) and persisted the
 * row → a corrupted attachment returned as a 200 success. The fix fails CLOSED: on `.truncated` it
 * deletes the partial object and throws 413, before any DB row or index job is created.
 *
 * The unit under test is the guard; that busboy actually sets `.truncated` at the correct boundary is
 * a library invariant covered end-to-end by the platform's real-parser integration test.
 */
describe('AttachmentService — #308 oversize upload fails closed (413), never truncate-and-succeed', () => {
  function makeService(storageService: any, attachmentRepo: any, attachmentQueue: any) {
    return new AttachmentService(
      storageService,
      attachmentRepo,
      {} as any, // userRepo
      {} as any, // workspaceRepo
      {} as any, // spaceRepo
      {} as any, // db
      attachmentQueue,
    );
  }

  /** A fake @fastify/multipart file whose stream is flagged truncated (the cap was hit). */
  function truncatedFile() {
    const stream = Readable.from([Buffer.alloc(16)]) as Readable & { truncated?: boolean };
    stream.truncated = true;
    return { filename: 'big.bin', file: stream };
  }

  it('deletes the partial object and throws PayloadTooLargeException; no row, no index job', async () => {
    const storageService = {
      upload: jest.fn().mockResolvedValue(undefined), // pipeline resolves — the truncated stream ends cleanly
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const attachmentRepo = { insertAttachment: jest.fn(), updateAttachment: jest.fn(), findById: jest.fn() };
    const attachmentQueue = { add: jest.fn() };
    const service = makeService(storageService, attachmentRepo, attachmentQueue);

    await expect(
      service.uploadFile({
        filePromise: Promise.resolve(truncatedFile() as any),
        pageId: 'page-1',
        userId: 'user-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    // The partial object is removed (cleanup), and NOTHING durable is created.
    expect(storageService.delete).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(attachmentRepo.updateAttachment).not.toHaveBeenCalled();
    expect(attachmentQueue.add).not.toHaveBeenCalled();
  });

  it('deletes the partial object and rethrows when the storage write itself fails mid-stream', async () => {
    const boom = new Error('connection reset');
    const storageService = {
      upload: jest.fn().mockRejectedValue(boom), // uploadToDrive wraps this as BadRequestException
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const attachmentRepo = { insertAttachment: jest.fn(), updateAttachment: jest.fn(), findById: jest.fn() };
    const attachmentQueue = { add: jest.fn() };
    const service = makeService(storageService, attachmentRepo, attachmentQueue);

    await expect(
      service.uploadFile({
        filePromise: Promise.resolve(truncatedFile() as any),
        pageId: 'page-1',
        userId: 'user-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      }),
    ).rejects.toThrow();

    expect(storageService.delete).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(attachmentQueue.add).not.toHaveBeenCalled();
  });
});
