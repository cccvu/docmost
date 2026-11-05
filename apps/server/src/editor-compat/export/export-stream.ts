/**
 * #699 — stream an export's attachments into its archive one at a time, and stop the whole archive on any failure.
 * Fork-owned.
 *
 * `LazyAttachmentStream` is what an attachment's zip entry reads from. It opens its storage object only when JSZip
 * first reads the entry, never when the entry is added: JSZip's input adapter pauses the stream and binds its
 * listeners at `file()` time (NodejsStreamInputAdapter.js:25-52), and ZipFileWorker resumes the sources strictly one
 * after another, the next one on the previous one's `end` (ZipFileWorker.js:458-490). So an export holds at most one
 * open storage object, which on S3 is one socket of the client's pool of 50. Opening every object up front instead
 * would wait forever on the pool from the 51st attachment on (the S3 client sets no request timeout).
 *
 * `ExportStreamRegistry` owns one export's stream lifecycle. JSZip cannot be trusted to report a failure: an error a
 * source emits while JSZip has it paused (normal backpressure from a slow client) is stored on the source and never
 * re-raised (NodejsStreamInputAdapter.js:38-43 writes `this.generatedError` on the stream), so the archive just stops.
 * The registry therefore never relies on it. Any failure (a storage error, a source closed before its end, the
 * streamed-bytes backstop, the wall-clock cap, a JSZip error) goes to `fail()`, which destroys the stream the
 * response is sending. Before the first byte that makes fastify answer the error as a normal 4xx/5xx; after it,
 * fastify destroys the connection (reply.js sendStream), so the client sees a failed download, never a short archive
 * that ends cleanly. The response stream is our own PassThrough, never JSZip's readable-stream 2 output: destroying
 * that one pushes `null`, which would END a piped response normally.
 *
 * The registry also destroys whatever is still open when the response ends or the client goes away: fastify destroys
 * only the payload stream (reply.js:797-798), which never reaches JSZip's sources.
 */
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { finished, PassThrough, Readable } from 'node:stream';
import {
  EXPORT_LIMIT_DEFAULTS,
  ExportLimits,
  ExportStorageException,
  ExportTimeoutException,
  ExportTooLargeException,
  withStorageTimeout,
} from './export-limits';

export type ExportAbortReason = 'wall_cap' | 'byte_cap' | 'storage_error' | 'zip_error';

export type OpenSource = () => Promise<Readable>;

export class LazyAttachmentStream extends Readable {
  private source: Readable | null = null;
  private started = false;
  private sourceEnded = false;

  constructor(
    private readonly registry: ExportStreamRegistry,
    /** Names the entry in logs (an attachment id, never a file name). */
    readonly label: string,
    private readonly open: OpenSource,
  ) {
    super();
  }

  /** Whether the storage object was ever opened (for tests and diagnostics). */
  get opened(): boolean {
    return this.started;
  }

  override _read(): void {
    if (this.source) {
      this.source.resume();
      return;
    }
    if (this.started) return; // the open is in flight
    this.started = true;
    let opening: Promise<Readable>;
    try {
      // A hung open would otherwise wait for the wall-clock cap; a stream that arrives too late is released at once.
      opening = withStorageTimeout(this.open(), this.registry.storageTimeoutMs, 'opening the object', (late) => late.destroy());
    } catch (err) {
      opening = Promise.reject(err);
    }
    opening.then(
      (src) => this.bind(src),
      (err) => {
        if (!this.destroyed) this.registry.sourceFailed(this, err);
      },
    );
  }

  private bind(src: Readable): void {
    if (this.destroyed) {
      // The export failed or the client left while the object was opening: release it at once.
      src.destroy();
      return;
    }
    this.source = src;
    src.on('data', (chunk: Buffer | string) => {
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (!this.registry.countBytes(n)) return;
      if (!this.push(chunk)) src.pause();
    });
    src.once('end', () => {
      this.sourceEnded = true;
      this.push(null);
    });
    finished(src, (err) => {
      if (this.destroyed) return; // we destroyed it ourselves
      if (err || !this.sourceEnded) {
        this.registry.sourceFailed(this, err ?? new Error('the storage stream closed before its end'));
      }
    });
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    const src = this.source;
    this.source = null;
    if (src && !src.destroyed) src.destroy();
    cb(err);
  }
}

type ZipOutput = NodeJS.ReadableStream & { destroy?: (err?: Error) => unknown; unpipe?: (dest?: NodeJS.WritableStream) => unknown };

export class ExportStreamRegistry {
  private readonly lazies = new Set<LazyAttachmentStream>();
  private readonly startedAt: number;
  private failure: Error | null = null;
  private disposed = false;
  private zipOut: ZipOutput | null = null;
  private out: PassThrough | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private streamed = 0;

  constructor(
    /** Names the export in logs, e.g. `page:<id>` or `space:<id>`. */
    readonly label: string,
    private readonly limits: Pick<ExportLimits, 'attachmentBytes' | 'maxDurationMs'> & Partial<Pick<ExportLimits, 'storageTimeoutMs'>>,
    private readonly logger: Pick<Logger, 'warn' | 'error'> = new Logger('Export'),
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** A lazily opened entry body for one attachment. */
  lazy(label: string, open: OpenSource): LazyAttachmentStream {
    const s = new LazyAttachmentStream(this, label, open);
    this.lazies.add(s);
    if (this.failure || this.disposed) s.destroy();
    return s;
  }

  /** How long one storage open may take (EXPORT_STORAGE_TIMEOUT_MS). */
  get storageTimeoutMs(): number {
    return this.limits.storageTimeoutMs ?? EXPORT_LIMIT_DEFAULTS.storageTimeoutMs;
  }

  get failed(): Error | null {
    return this.failure;
  }

  get streamedBytes(): number {
    return this.streamed;
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  /**
   * Wire JSZip's output to the stream the response sends, and arm the wall-clock cap for what is left of the export's
   * budget. Throws (before any byte) when the export already failed.
   */
  attach(zipOut: ZipOutput): Readable {
    if (this.out) throw new Error('ExportStreamRegistry.attach: already attached');
    this.zipOut = zipOut;
    // JSZip reports some failures here (e.g. a source error while it was NOT paused). Never left unhandled.
    zipOut.on('error', (err: Error) =>
      this.fail('zip_error', new InternalServerErrorException('The export could not be built.'), err),
    );
    if (this.failure) {
      this.teardown();
      throw this.failure;
    }
    const out = new PassThrough();
    this.out = out;
    finished(out, () => this.dispose()); // the archive ended, the export failed, or the client went away
    zipOut.pipe(out);
    const remaining = Math.max(0, this.limits.maxDurationMs - (this.now() - this.startedAt));
    this.timer = setTimeout(
      () => this.fail('wall_cap', new ExportTimeoutException(this.limits.maxDurationMs)),
      remaining,
    );
    (this.timer as { unref?: () => void }).unref?.();
    return out;
  }

  /** The streamed-bytes backstop: false (and the export failed) once more bytes arrived than the budget allows. */
  countBytes(n: number): boolean {
    if (this.failure || this.disposed) return false;
    this.streamed += n;
    if (this.streamed > this.limits.attachmentBytes) {
      this.fail('byte_cap', new ExportTooLargeException('attachments', this.streamed, this.limits.attachmentBytes));
      return false;
    }
    return true;
  }

  /** A storage object could not be opened, errored, or closed before its end. */
  sourceFailed(source: LazyAttachmentStream, cause: unknown): void {
    this.fail('storage_error', new ExportStorageException(), cause, source.label);
  }

  /** Stop the export: log once, destroy every open source, and destroy the response stream with `clientError`. */
  fail(reason: ExportAbortReason, clientError: Error, cause?: unknown, entry?: string): void {
    if (this.failure || this.disposed) return;
    this.failure = clientError;
    const why = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause);
    const line =
      `EXPORT_ABORTED reason=${reason} export=${this.label}${entry ? ` attachment=${entry}` : ''} ` +
      `elapsedMs=${this.now() - this.startedAt} streamedBytes=${this.streamed}${why ? `: ${why}` : ''}`;
    if (reason === 'storage_error' || reason === 'zip_error') this.logger.error(line);
    else this.logger.warn(line);
    this.teardown(clientError);
  }

  /** The response is over (complete, failed or abandoned): release everything still open. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
  }

  private teardown(err?: Error): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const out = this.out;
    const zipOut = this.zipOut;
    // Order matters: unpipe and destroy the response stream FIRST. Destroying JSZip's readable-stream 2 output pushes
    // `null`, and while still piped that would end the response as if the archive were complete.
    if (zipOut && out) zipOut.unpipe?.(out);
    if (out && !out.destroyed && (err || !out.readableEnded)) out.destroy(err);
    for (const s of this.lazies) if (!s.destroyed) s.destroy();
    if (zipOut && typeof zipOut.destroy === 'function') {
      try {
        zipOut.destroy();
      } catch {
        // nothing more to release
      }
    }
  }
}
