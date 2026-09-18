import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';

/**
 * CCC #308 (UPSTREAM #146): both `err?.statusCode === 413` branches in `uploadFile` must surface a real
 * 413 (`PayloadTooLargeException`), not the upstream 400 (`BadRequestException`) — matching the platform
 * `/v1` contract. The service spec proves the SERVICE throws 413, but that never exercises the CONTROLLER
 * branches, so a silent revert to `BadRequestException` would keep every other fork test green. These
 * drive the controller directly: (1) `req.file()` rejecting 413 (busboy field/size limit), and (2) the
 * service rejecting 413 (the truncation guard) — plus a non-413 error to prove the branch discriminates.
 */
describe('AttachmentController.uploadFile — #308 preserves the real 413 (not 400)', () => {
  function makeController(overrides: {
    reqFile: jest.Mock;
    uploadFile?: jest.Mock;
  }) {
    const attachmentService = { uploadFile: overrides.uploadFile ?? jest.fn() } as any;
    const environmentService = { getFileUploadSizeLimit: () => '50mb' } as any;
    const pageRepo = { findById: jest.fn().mockResolvedValue({ id: 'page-1', spaceId: 's1' }) } as any;
    const pageAccessService = { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any;
    const auditService = { log: jest.fn() } as any;

    const controller = new AttachmentController(
      attachmentService,
      {} as any, // storageService
      {} as any, // workspaceAbility
      {} as any, // spaceAbility
      pageRepo,
      {} as any, // attachmentRepo
      environmentService,
      {} as any, // tokenService
      pageAccessService,
      auditService,
    );
    const req = { file: overrides.reqFile } as any;
    const res = { send: jest.fn() } as any;
    return { controller, req, res, attachmentService, auditService };
  }

  const user = { id: 'user-1' } as any;
  const workspace = { id: 'ws-1' } as any;

  it('maps a 413 from req.file() (field/size limit) to PayloadTooLargeException, not BadRequestException', async () => {
    const { controller, req, res } = makeController({
      reqFile: jest.fn().mockRejectedValue({ statusCode: 413, message: 'request file too large' }),
    });

    await expect(controller.uploadFile(req, res, user, workspace)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it('maps a 413 from the upload service (truncation guard) to PayloadTooLargeException, not BadRequestException', async () => {
    const { controller, req, res, auditService } = makeController({
      reqFile: jest.fn().mockResolvedValue({ fields: { pageId: { value: 'page-1' } } }),
      uploadFile: jest.fn().mockRejectedValue(new PayloadTooLargeException('File too large')),
    });

    await expect(controller.uploadFile(req, res, user, workspace)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(res.send).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('still maps a non-413 service error to BadRequestException (the 413 branch discriminates)', async () => {
    const { controller, req, res } = makeController({
      reqFile: jest.fn().mockResolvedValue({ fields: { pageId: { value: 'page-1' } } }),
      uploadFile: jest.fn().mockRejectedValue(new Error('disk on fire')),
    });

    await expect(controller.uploadFile(req, res, user, workspace)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(res.send).not.toHaveBeenCalled();
  });
});
