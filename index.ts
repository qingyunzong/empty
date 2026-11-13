export type UploadTransactionStatus =
  | "ready"
  | "invalid"
  | "uploading"
  | "retrying"
  | "committing"
  | "committed"
  | "cancelled"
  | "failed";

export type UploadChunkStatus =
  | "pending"
  | "uploading"
  | "acknowledged"
  | "failed";

export interface UploadValidationIssue {
  code: string;
  message: string;
  field?: "name" | "size" | "type" | "extension" | "content";
}

export interface UploadValidationChecks {
  name: boolean;
  size: boolean;
  type: boolean;
  extension: boolean;
  content: boolean;
}

export interface UploadValidationResult {
  valid: boolean;
  checks: UploadValidationChecks;
  issues: UploadValidationIssue[];
}

export interface UploadValidationContext {
  uploadId: string;
  fileName: string;
  size: number;
  mimeType: string;
  lastModified: number;
  contentDigest: string;
  bytes: Uint8Array;
}

export type UploadValidationDecision =
  | boolean
  | void
  | UploadValidationIssue[]
  | {
      valid?: boolean;
      issues?: UploadValidationIssue[];
    };

export interface UploadValidationPolicy {
  minBytes?: number;
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
  allowedExtensions?: readonly string[];
  validate?:
    | ((
        context: UploadValidationContext,
      ) => UploadValidationDecision | Promise<UploadValidationDecision>)
    | undefined;
}

export interface UploadChunkManifest {
  index: number;
  offset: number;
  size: number;
  digest: string;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  ratio: number;
  percent: number;
  acknowledgedChunks: number;
  totalChunks: number;
}

export interface UploadChunkRequest {
  uploadId: string;
  fileName: string;
  contentDigest: string;
  chunkIndex: number;
  totalChunks: number;
  offset: number;
  size: number;
  chunkDigest: string;
  data: Uint8Array;
  index: number;
  digest: string;
}

export interface ChunkReceipt {
  uploadId?: string;
  chunkIndex?: number;
  accepted?: boolean;
  ok?: boolean;
  status?: string;
  missingChunks?: number[];
  [key: string]: unknown;
}

export interface CompleteUploadRequest {
  uploadId: string;
  fileName: string;
  size: number;
  contentDigest: string;
  totalChunks: number;
  chunks: UploadChunkManifest[];
}

export interface ServerUploadReceipt {
  uploadId?: string;
  contentDigest?: string;
  accepted?: boolean;
  ok?: boolean;
  committed?: boolean;
  status?: string;
  receiptId?: string;
  receipt_id?: string;
  id?: string;
  attachmentId?: string;
  attachment_id?: string;
  missingChunks?: number[];
  receivedAt?: string;
  [key: string]: unknown;
}

export interface UploadTransport {
  uploadChunk(request: UploadChunkRequest): Promise<ChunkReceipt | void>;
  complete?(
    request: CompleteUploadRequest,
  ): Promise<ServerUploadReceipt | void>;
  abort?(uploadId: string, reason?: string): Promise<void> | void;
}

export interface UploadTransactionOptions {
  transport?: UploadTransport;
  uploader?: UploadTransport;
  uploadChunk?: UploadTransport["uploadChunk"];
  complete?: UploadTransport["complete"];
  abort?: UploadTransport["abort"];
  chunkSize?: number;
  validation?: UploadValidationPolicy;
  createUploadId?: () => string;
  now?: () => Date;
  onProgress?: (
    progress: UploadProgress,
    snapshot: UploadTransactionSnapshot,
  ) => void;
  onAttachmentRow?: (row: AttachmentRow) => void;
  onStateChange?: (
    snapshot: UploadTransactionSnapshot,
    previousStatus: UploadTransactionStatus,
  ) => void;
}

export interface SelectFileOptions {
  fileName?: string;
  mimeType?: string;
  lastModified?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface UploadSource {
  name?: string;
  size?: number;
  type?: string;
  lastModified?: number;
  data?: ArrayBuffer | ArrayBufferView | Blob | string;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface UploadChunkState extends UploadChunkManifest {
  status: UploadChunkStatus;
  attempts: number;
  acknowledgedAt: string | null;
}

export interface NormalizedServerReceipt {
  uploadId: string;
  contentDigest: string;
  accepted: true;
  receiptId: string;
  attachmentId: string;
  receivedAt: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface AttachmentRow {
  id: string;
  uploadId: string;
  fileName: string;
  name: string;
  size: number;
  mimeType: string;
  contentDigest: string;
  status: UploadTransactionStatus;
  progress: UploadProgress;
  validation: UploadValidationResult;
  serverReceiptId: string | null;
  attachmentId: string | null;
  committed: boolean;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UploadTransactionSnapshot {
  uploadId: string;
  fileName: string;
  name: string;
  size: number;
  mimeType: string;
  lastModified: number;
  contentDigest: string;
  chunkSize: number;
  totalChunks: number;
  status: UploadTransactionStatus;
  validation: UploadValidationResult;
  progress: UploadProgress;
  chunks: UploadChunkState[];
  serverReceipt: NormalizedServerReceipt | null;
  attachmentRow: AttachmentRow;
  committed: boolean;
  cancelled: boolean;
  attemptCount: number;
  lateSuccessesIgnored: number;
  error: SerializedError | null;
  abortError: SerializedError | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface SerializedError {
  name: string;
  message: string;
  code: string;
}

export interface EvidenceSummary {
  total: number;
  ready: number;
  invalid: number;
  uploading: number;
  committed: number;
  cancelled: number;
  failed: number;
  lateSuccessesIgnored: number;
}

export interface EvidenceInvariants {
  attachmentRowsBoundToUploadId: boolean;
  everyCommittedUploadHasServerReceipt: boolean;
  everyCommittedRowIsCommitted: boolean;
  noCancelledUploadIsCommitted: boolean;
  committedUploadIdsUnique: boolean;
}

export interface UploadEvidence {
  schema: "upload-transaction-evidence/v1";
  capturedAt: string;
  uploads: UploadTransactionSnapshot[];
  attachmentRows: AttachmentRow[];
  committedUploadIds: string[];
  committedContentDigests: string[];
  summary: EvidenceSummary;
  invariants: EvidenceInvariants;
}

export type UploadEventListener = (event: UploadEvent) => void;

export type UploadEvent =
  | { type: "state"; snapshot: UploadTransactionSnapshot }
  | {
      type: "progress";
      snapshot: UploadTransactionSnapshot;
      progress: UploadProgress;
    }
  | { type: "attachment-row"; row: AttachmentRow };

export interface UploadFileResult {
  transaction: UploadTransactionSnapshot;
  evidence: UploadEvidence;
}

interface InternalChunk extends UploadChunkManifest {
  data: Uint8Array;
  status: UploadChunkStatus;
  attempts: number;
  acknowledgedAt: string | null;
}

interface InternalTransaction {
  uploadId: string;
  fileName: string;
  size: number;
  mimeType: string;
  lastModified: number;
  contentDigest: string;
  chunkSize: number;
  chunks: InternalChunk[];
  status: UploadTransactionStatus;
  validation: UploadValidationResult;
  serverReceipt: NormalizedServerReceipt | null;
  attemptCount: number;
  lateSuccessesIgnored: number;
  error: SerializedError | null;
  abortError: SerializedError | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  metadata: Readonly<Record<string, unknown>>;
  runToken: number;
  activePromise: Promise<UploadTransactionSnapshot> | null;
}

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const EVIDENCE_SCHEMA = "upload-transaction-evidence/v1" as const;

export class UploadComponentError extends Error {
  code: string;
  uploadId: string | null;

  constructor(code: string, message: string, uploadId: string | null = null) {
    super(message);
    this.name = "UploadComponentError";
    this.code = code;
    this.uploadId = uploadId;
  }
}

export class UploadSourceError extends UploadComponentError {
  constructor(message: string) {
    super("invalid_source", message);
    this.name = "UploadSourceError";
  }
}

export class UploadValidationError extends UploadComponentError {
  validation: UploadValidationResult;

  constructor(uploadId: string, validation: UploadValidationResult) {
    super(
      "validation_failed",
      `Upload ${uploadId} failed client validation.`,
      uploadId,
    );
    this.name = "UploadValidationError";
    this.validation = validation;
  }
}

export class UploadCancelledError extends UploadComponentError {
  constructor(uploadId: string) {
    super("cancelled", `Upload ${uploadId} was cancelled.`, uploadId);
    this.name = "UploadCancelledError";
  }
}

export class UploadTransportError extends UploadComponentError {
  constructor(uploadId: string, message: string) {
    super("transport_error", message, uploadId);
    this.name = "UploadTransportError";
  }
}

export class UploadRejectedError extends UploadComponentError {
  constructor(uploadId: string, message: string) {
    super("server_rejected", message, uploadId);
    this.name = "UploadRejectedError";
  }
}

export class UploadProtocolError extends UploadComponentError {
  constructor(uploadId: string, message: string) {
    super("protocol_error", message, uploadId);
    this.name = "UploadProtocolError";
  }
}

export class MissingChunksError extends UploadComponentError {
  missingChunks: number[];

  constructor(uploadId: string, missingChunks: number[]) {
    super(
      "missing_chunks",
      `Server still needs chunks for ${uploadId}: ${missingChunks.join(", ")}.`,
      uploadId,
    );
    this.name = "MissingChunksError";
    this.missingChunks = missingChunks;
  }
}

export class UploadTransactionComponent {
  private readonly transport: UploadTransport | null;
  private readonly chunkSize: number;
  private readonly validationPolicy: UploadValidationPolicy;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly records = new Map<string, InternalTransaction>();
  private readonly issuedIds = new Set<string>();
  private readonly committedIds = new Set<string>();
  private readonly listeners = new Set<UploadEventListener>();
  private readonly onProgress:
    | ((progress: UploadProgress, snapshot: UploadTransactionSnapshot) => void)
    | undefined;
  private readonly onAttachmentRow: ((row: AttachmentRow) => void) | undefined;
  private readonly onStateChange:
    | ((
        snapshot: UploadTransactionSnapshot,
        previousStatus: UploadTransactionStatus,
      ) => void)
    | undefined;

  constructor(options?: UploadTransactionOptions);
  constructor(
    transport: UploadTransport,
    options?: UploadTransactionOptions,
  );
  constructor(
    optionsOrTransport: UploadTransactionOptions | UploadTransport = {},
    extraOptions: UploadTransactionOptions = {},
  ) {
    const options = isUploadTransport(optionsOrTransport)
      ? { ...extraOptions, transport: optionsOrTransport }
      : optionsOrTransport;
    const directTransport =
      typeof options.uploadChunk === "function"
        ? {
            uploadChunk: options.uploadChunk,
            complete: options.complete,
            abort: options.abort,
          }
        : null;
    this.transport = options.transport ?? options.uploader ?? directTransport;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.validationPolicy = options.validation ?? {};
    this.idFactory = options.createUploadId ?? defaultUploadId;
    this.clock = options.now ?? (() => new Date());
    this.onProgress = options.onProgress;
    this.onAttachmentRow = options.onAttachmentRow;
    this.onStateChange = options.onStateChange;

    if (!Number.isInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive integer.");
    }
    if (
      this.validationPolicy.minBytes !== undefined &&
      this.validationPolicy.minBytes < 0
    ) {
      throw new RangeError("validation.minBytes cannot be negative.");
    }
    if (
      this.validationPolicy.maxBytes !== undefined &&
      this.validationPolicy.maxBytes < 0
    ) {
      throw new RangeError("validation.maxBytes cannot be negative.");
    }
  }

  get attachmentRows(): readonly AttachmentRow[] {
    return this.getAttachmentRows();
  }

  get committedUploadIds(): readonly string[] {
    return [...this.committedIds];
  }

  async selectFile(
    source: UploadSource | File | Blob,
    options: SelectFileOptions = {},
  ): Promise<UploadTransactionSnapshot> {
    const selected = source as UploadSource;
    const bytes = await readSourceBytes(selected);
    const fileName = String(
      selected.name ?? options.fileName ?? fileNameFromBlob(source) ?? "",
    );
    const mimeType = String(
      selected.type || options.mimeType || "application/octet-stream",
    );
    const lastModified = Number(
      selected.lastModified ?? options.lastModified ?? 0,
    );
    const uploadId = this.nextUploadId();
    const contentDigest = await sha256Hex(bytes);
    const chunks: InternalChunk[] = [];

    for (let offset = 0; offset < bytes.byteLength; offset += this.chunkSize) {
      const end = Math.min(offset + this.chunkSize, bytes.byteLength);
      const data = bytes.subarray(offset, end);
      chunks.push({
        index: chunks.length,
        offset,
        size: data.byteLength,
        digest: await sha256Hex(data),
        data,
        status: "pending",
        attempts: 0,
        acknowledgedAt: null,
      });
    }

    const validation = await this.validate({
      uploadId,
      fileName,
      size: bytes.byteLength,
      mimeType,
      lastModified,
      contentDigest,
      bytes,
    });
    const createdAt = this.now();
    const record: InternalTransaction = {
      uploadId,
      fileName,
      size: bytes.byteLength,
      mimeType,
      lastModified,
      contentDigest,
      chunkSize: this.chunkSize,
      chunks,
      status: validation.valid ? "ready" : "invalid",
      validation,
      serverReceipt: null,
      attemptCount: 0,
      lateSuccessesIgnored: 0,
      error: null,
      abortError: null,
      createdAt,
      updatedAt: createdAt,
      committedAt: null,
      cancelledAt: null,
      metadata: { ...(options.metadata ?? {}) },
      runToken: 0,
      activePromise: null,
    };

    this.records.set(uploadId, record);
    this.emitState(record);
    this.emitAttachmentRow(record);
    return this.snapshot(record);
  }

  async upload(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): Promise<UploadTransactionSnapshot> {
    const record = this.requireRecord(uploadId);

    if (record.status === "committed" || record.status === "cancelled") {
      return this.snapshot(record);
    }
    if (record.activePromise) {
      return record.activePromise;
    }
    if (!record.validation.valid) {
      throw new UploadValidationError(record.uploadId, record.validation);
    }

    return this.startRun(record, false);
  }

  async retry(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): Promise<UploadTransactionSnapshot> {
    const record = this.requireRecord(uploadId);

    if (record.status === "committed") {
      return this.snapshot(record);
    }
    if (record.status === "cancelled") {
      throw new UploadCancelledError(record.uploadId);
    }
    if (record.activePromise) {
      return record.activePromise;
    }
    if (!record.validation.valid) {
      throw new UploadValidationError(record.uploadId, record.validation);
    }

    return this.startRun(record, true);
  }

  async cancel(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
    reason = "cancelled by user",
  ): Promise<UploadTransactionSnapshot> {
    const record = this.requireRecord(uploadId);

    if (record.status === "committed") {
      return this.snapshot(record);
    }
    if (record.status === "cancelled") {
      return this.snapshot(record);
    }

    const previousStatus = record.status;
    record.runToken += 1;
    record.status = "cancelled";
    record.cancelledAt = this.now();
    record.updatedAt = record.cancelledAt;
    record.error = null;
    for (const chunk of record.chunks) {
      if (chunk.status === "uploading") {
        chunk.status = "pending";
      }
    }
    this.committedIds.delete(record.uploadId);
    this.emitState(record, previousStatus);
    this.emitAttachmentRow(record);

    try {
      const abortResult = this.transport?.abort?.(record.uploadId, reason);
      if (abortResult && typeof abortResult.catch === "function") {
        void abortResult.catch((error: unknown) => {
          record.abortError = serializeError(error);
          record.updatedAt = this.now();
          this.emitAttachmentRow(record);
        });
      }
    } catch (error) {
      record.abortError = serializeError(error);
      record.updatedAt = this.now();
      this.emitAttachmentRow(record);
    }

    return this.snapshot(record);
  }

  getSnapshot(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): UploadTransactionSnapshot {
    return this.snapshot(this.requireRecord(uploadId));
  }

  getAttachmentRow(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): AttachmentRow {
    return this.attachmentRow(this.requireRecord(uploadId));
  }

  getAttachmentRows(): AttachmentRow[] {
    return [...this.records.values()].map((record) =>
      this.attachmentRow(record),
    );
  }

  getAttachmentRowsByName(fileName: string): AttachmentRow[] {
    return this.getAttachmentRows().filter((row) => row.fileName === fileName);
  }

  getAttachmentRowsByDigest(contentDigest: string): AttachmentRow[] {
    const digest = normalizeDigest(contentDigest);
    return this.getAttachmentRows().filter(
      (row) => row.contentDigest === digest,
    );
  }

  getCommittedUploads(): UploadTransactionSnapshot[] {
    return [...this.committedIds]
      .map((uploadId) => this.records.get(uploadId))
      .filter((record): record is InternalTransaction => record !== undefined)
      .map((record) => this.snapshot(record));
  }

  getCommittedSet(): ReadonlySet<string> {
    return new Set(this.committedIds);
  }

  isCommitted(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): boolean {
    return this.committedIds.has(resolveUploadId(uploadId));
  }

  subscribe(listener: UploadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEvidence(): UploadEvidence {
    const uploads = [...this.records.values()].map((record) =>
      this.snapshot(record),
    );
    const attachmentRows = uploads.map((upload) => upload.attachmentRow);
    const committedUploads = uploads.filter((upload) => upload.committed);
    const summary: EvidenceSummary = {
      total: uploads.length,
      ready: uploads.filter((upload) => upload.status === "ready").length,
      invalid: uploads.filter((upload) => upload.status === "invalid").length,
      uploading: uploads.filter(
        (upload) =>
          upload.status === "uploading" ||
          upload.status === "retrying" ||
          upload.status === "committing",
      ).length,
      committed: committedUploads.length,
      cancelled: uploads.filter((upload) => upload.cancelled).length,
      failed: uploads.filter((upload) => upload.status === "failed").length,
      lateSuccessesIgnored: uploads.reduce(
        (total, upload) => total + upload.lateSuccessesIgnored,
        0,
      ),
    };
    const committedIds = committedUploads.map((upload) => upload.uploadId);
    const invariants: EvidenceInvariants = {
      attachmentRowsBoundToUploadId: attachmentRows.every(
        (row) => row.id === row.uploadId,
      ),
      everyCommittedUploadHasServerReceipt: committedUploads.every(
        (upload) => upload.serverReceipt !== null,
      ),
      everyCommittedRowIsCommitted: attachmentRows
        .filter((row) => row.committed)
        .every(
          (row) =>
            committedUploads.find((upload) => upload.uploadId === row.uploadId)
              ?.committed === true,
        ),
      noCancelledUploadIsCommitted: uploads
        .filter((upload) => upload.cancelled)
        .every((upload) => !upload.committed),
      committedUploadIdsUnique:
        new Set(committedIds).size === committedIds.length,
    };

    return {
      schema: EVIDENCE_SCHEMA,
      capturedAt: this.now(),
      uploads,
      attachmentRows,
      committedUploadIds: committedIds,
      committedContentDigests: committedUploads.map(
        (upload) => upload.contentDigest,
      ),
      summary,
      invariants,
    };
  }

  getFinalEvidence(): UploadEvidence {
    return this.getEvidence();
  }

  toJSON(): UploadEvidence {
    return this.getEvidence();
  }

  private startRun(
    record: InternalTransaction,
    isRetry: boolean,
  ): Promise<UploadTransactionSnapshot> {
    const previousStatus = record.status;
    const runToken = record.runToken + 1;
    record.runToken = runToken;
    record.status = isRetry ? "retrying" : "uploading";
    record.attemptCount += 1;
    record.error = null;
    record.updatedAt = this.now();
    this.emitState(record, previousStatus);
    this.emitAttachmentRow(record);

    const task = this.performRun(record, runToken);
    record.activePromise = task;
    const clear = () => {
      if (record.activePromise === task) {
        record.activePromise = null;
      }
    };
    void task.then(clear, clear);
    return task;
  }

  private async performRun(
    record: InternalTransaction,
    runToken: number,
  ): Promise<UploadTransactionSnapshot> {
    try {
      const chunkTransport = this.transport?.uploadChunk;
      if (!chunkTransport) {
        throw new UploadTransportError(
          record.uploadId,
          "No upload transport with uploadChunk() was configured.",
        );
      }

      for (const chunk of record.chunks) {
        if (!this.isCurrentRun(record, runToken)) {
          throw new UploadCancelledError(record.uploadId);
        }
        if (chunk.status === "acknowledged") {
          continue;
        }

        chunk.status = "uploading";
        chunk.attempts += 1;
        record.updatedAt = this.now();
        let receipt: ChunkReceipt | void;
        try {
          receipt = await chunkTransport.call(
            this.transport,
            this.chunkRequest(record, chunk),
          );
        } catch (error) {
          if (!this.isCurrentRun(record, runToken)) {
            throw new UploadCancelledError(record.uploadId);
          }
          chunk.status = "failed";
          throw error;
        }

        if (!this.isCurrentRun(record, runToken)) {
          if (isChunkReceiptSuccess(receipt)) {
            record.lateSuccessesIgnored += 1;
          }
          throw new UploadCancelledError(record.uploadId);
        }

        this.assertChunkReceipt(record, chunk, receipt);
        const missing = normalizeMissingChunks(receipt?.missingChunks, record);
        if (missing.includes(chunk.index)) {
          chunk.status = "failed";
          throw new MissingChunksError(record.uploadId, missing);
        }
        for (const index of missing) {
          const missingChunk = record.chunks[index];
          if (missingChunk) {
            missingChunk.status = "pending";
            missingChunk.acknowledgedAt = null;
          }
        }

        chunk.status = "acknowledged";
        chunk.acknowledgedAt = this.now();
        record.updatedAt = chunk.acknowledgedAt;
        this.emitProgress(record);
        this.emitAttachmentRow(record);
      }

      if (!this.isCurrentRun(record, runToken)) {
        throw new UploadCancelledError(record.uploadId);
      }
      const unacknowledged = record.chunks
        .filter((chunk) => chunk.status !== "acknowledged")
        .map((chunk) => chunk.index);
      if (unacknowledged.length > 0) {
        throw new MissingChunksError(record.uploadId, unacknowledged);
      }

      const previousStatus = record.status;
      record.status = "committing";
      record.updatedAt = this.now();
      this.emitState(record, previousStatus);
      this.emitAttachmentRow(record);

      let rawReceipt: ServerUploadReceipt | void;
      try {
        rawReceipt = this.transport?.complete
          ? await this.transport.complete.call(
              this.transport,
              this.completeRequest(record),
            )
          : undefined;
      } catch (error) {
        if (!this.isCurrentRun(record, runToken)) {
          throw new UploadCancelledError(record.uploadId);
        }
        throw error;
      }

      if (!this.isCurrentRun(record, runToken)) {
        if (isServerReceiptSuccess(rawReceipt)) {
          record.lateSuccessesIgnored += 1;
        }
        throw new UploadCancelledError(record.uploadId);
      }

      const missing = normalizeMissingChunks(rawReceipt?.missingChunks, record);
      if (missing.length > 0) {
        for (const index of missing) {
          record.chunks[index].status = "failed";
        }
        throw new MissingChunksError(record.uploadId, missing);
      }

      const normalizedReceipt = this.normalizeServerReceipt(
        record,
        rawReceipt,
      );
      record.serverReceipt = normalizedReceipt;
      record.status = "committed";
      record.committedAt = this.now();
      record.updatedAt = record.committedAt;
      this.committedIds.add(record.uploadId);
      this.emitState(record, "committing");
      this.emitProgress(record);
      this.emitAttachmentRow(record);
      return this.snapshot(record);
    } catch (error) {
      if (!this.isCurrentRun(record, runToken)) {
        if (record.status !== "cancelled") {
          record.status = "cancelled";
          record.cancelledAt = record.cancelledAt ?? this.now();
          record.updatedAt = this.now();
          this.emitState(record);
          this.emitAttachmentRow(record);
        }
        throw new UploadCancelledError(record.uploadId);
      }

      const previousStatus = record.status;
      record.status = "failed";
      record.error = serializeError(error);
      record.updatedAt = this.now();
      this.emitState(record, previousStatus);
      this.emitAttachmentRow(record);
      throw error;
    }
  }

  private isCurrentRun(
    record: InternalTransaction,
    runToken: number,
  ): boolean {
    return (
      record.runToken === runToken &&
      record.status !== "cancelled" &&
      !record.committedAt
    );
  }

  private assertChunkReceipt(
    record: InternalTransaction,
    chunk: InternalChunk,
    receipt: ChunkReceipt | void,
  ): void {
    if (!receipt) {
      return;
    }
    if (
      receipt.uploadId !== undefined &&
      receipt.uploadId !== record.uploadId
    ) {
      throw new UploadProtocolError(
        record.uploadId,
        `Chunk receipt belongs to ${String(receipt.uploadId)}, expected ${record.uploadId}.`,
      );
    }
    if (
      receipt.chunkIndex !== undefined &&
      receipt.chunkIndex !== chunk.index
    ) {
      throw new UploadProtocolError(
        record.uploadId,
        `Chunk receipt index ${String(receipt.chunkIndex)} does not match ${chunk.index}.`,
      );
    }
    if (receipt.index !== undefined && Number(receipt.index) !== chunk.index) {
      throw new UploadProtocolError(
        record.uploadId,
        `Chunk receipt index ${String(receipt.index)} does not match ${chunk.index}.`,
      );
    }
    if (
      receipt.status === "rejected" ||
      receipt.status === "error" ||
      receipt.accepted === false ||
      receipt.ok === false
    ) {
      throw new UploadRejectedError(
        record.uploadId,
        `Server rejected chunk ${chunk.index}.`,
      );
    }
  }

  private normalizeServerReceipt(
    record: InternalTransaction,
    rawReceipt: ServerUploadReceipt | void,
  ): NormalizedServerReceipt {
    if (!rawReceipt) {
      const receivedAt = this.now();
      return {
        uploadId: record.uploadId,
        contentDigest: record.contentDigest,
        accepted: true,
        receiptId: `local_${record.uploadId}`,
        attachmentId: `attachment_${record.uploadId}`,
        receivedAt,
        raw: {},
      };
    }

    if (
      rawReceipt.uploadId !== undefined &&
      rawReceipt.uploadId !== record.uploadId
    ) {
      throw new UploadProtocolError(
        record.uploadId,
        `Server receipt belongs to ${String(rawReceipt.uploadId)}, expected ${record.uploadId}.`,
      );
    }
    const receiptContentDigest = firstString(
      rawReceipt.contentDigest,
      rawReceipt.sha256,
      rawReceipt.digest,
    );
    if (receiptContentDigest !== null) {
      const receiptDigest = normalizeDigest(receiptContentDigest);
      if (receiptDigest !== record.contentDigest) {
        throw new UploadProtocolError(
          record.uploadId,
          "Server receipt content digest does not match the selected file.",
        );
      }
    }
    if (
      rawReceipt.status === "rejected" ||
      rawReceipt.status === "error" ||
      rawReceipt.status === "failed" ||
      rawReceipt.accepted === false ||
      rawReceipt.ok === false ||
      rawReceipt.committed === false
    ) {
      throw new UploadRejectedError(
        record.uploadId,
        "Server rejected the completed upload.",
      );
    }

    const receiptId =
      firstString(
        rawReceipt.receiptId,
        rawReceipt.receipt_id,
        rawReceipt.id,
      ) ?? `receipt_${record.uploadId}`;
    const attachmentId =
      firstString(rawReceipt.attachmentId, rawReceipt.attachment_id) ??
      `attachment_${record.uploadId}`;
    return {
      uploadId: record.uploadId,
      contentDigest: record.contentDigest,
      accepted: true,
      receiptId,
      attachmentId,
      receivedAt: firstString(rawReceipt.receivedAt) ?? this.now(),
      raw: { ...rawReceipt },
    };
  }

  private chunkRequest(
    record: InternalTransaction,
    chunk: InternalChunk,
  ): UploadChunkRequest {
    return {
      uploadId: record.uploadId,
      fileName: record.fileName,
      contentDigest: record.contentDigest,
      chunkIndex: chunk.index,
      totalChunks: record.chunks.length,
      offset: chunk.offset,
      size: chunk.size,
      chunkDigest: chunk.digest,
      data: chunk.data,
      index: chunk.index,
      digest: chunk.digest,
    };
  }

  private completeRequest(record: InternalTransaction): CompleteUploadRequest {
    return {
      uploadId: record.uploadId,
      fileName: record.fileName,
      size: record.size,
      contentDigest: record.contentDigest,
      totalChunks: record.chunks.length,
      chunks: record.chunks.map((chunk) => ({
        index: chunk.index,
        offset: chunk.offset,
        size: chunk.size,
        digest: chunk.digest,
      })),
    };
  }

  private async validate(
    context: UploadValidationContext,
  ): Promise<UploadValidationResult> {
    const issues: UploadValidationIssue[] = [];
    const policy = this.validationPolicy;
    const extension = extensionOf(context.fileName);
    const nameValid = context.fileName.trim().length > 0;
    const minimum = policy.minBytes ?? 1;
    const sizeValid =
      context.size >= minimum &&
      (policy.maxBytes === undefined || context.size <= policy.maxBytes);
    const typeValid =
      !policy.allowedMimeTypes ||
      policy.allowedMimeTypes.length === 0 ||
      policy.allowedMimeTypes.some((allowed) =>
        mimeMatches(allowed, context.mimeType),
      );
    const extensionValid =
      !policy.allowedExtensions ||
      policy.allowedExtensions.length === 0 ||
      policy.allowedExtensions.some(
        (allowed) => allowed.toLowerCase().replace(/^\./, "") === extension,
      );

    if (!nameValid) {
      issues.push({
        code: "missing_name",
        message: "A file name is required.",
        field: "name",
      });
    }
    if (context.size < minimum) {
      issues.push({
        code: context.size === 0 ? "empty_file" : "file_too_small",
        message: `File must be at least ${minimum} bytes.`,
        field: "size",
      });
    }
    if (policy.maxBytes !== undefined && context.size > policy.maxBytes) {
      issues.push({
        code: "file_too_large",
        message: `File must not exceed ${policy.maxBytes} bytes.`,
        field: "size",
      });
    }
    if (!typeValid) {
      issues.push({
        code: "mime_type_not_allowed",
        message: `MIME type ${context.mimeType} is not allowed.`,
        field: "type",
      });
    }
    if (!extensionValid) {
      issues.push({
        code: "extension_not_allowed",
        message: `File extension .${extension || "(none)"} is not allowed.`,
        field: "extension",
      });
    }

    let contentValid = true;
    if (policy.validate) {
      const decision = await policy.validate(context);
      if (decision === false) {
        contentValid = false;
        issues.push({
          code: "custom_validation_failed",
          message: "Custom file validation failed.",
          field: "content",
        });
      } else if (Array.isArray(decision)) {
        contentValid = decision.length === 0;
        issues.push(...decision);
      } else if (decision && typeof decision === "object") {
        contentValid = decision.valid !== false && !decision.issues?.length;
        issues.push(...(decision.issues ?? []));
      }
    }

    return {
      valid: issues.length === 0,
      checks: {
        name: nameValid,
        size: sizeValid,
        type: typeValid,
        extension: extensionValid,
        content: contentValid,
      },
      issues,
    };
  }

  private snapshot(record: InternalTransaction): UploadTransactionSnapshot {
    return {
      uploadId: record.uploadId,
      fileName: record.fileName,
      name: record.fileName,
      size: record.size,
      mimeType: record.mimeType,
      lastModified: record.lastModified,
      contentDigest: record.contentDigest,
      chunkSize: record.chunkSize,
      totalChunks: record.chunks.length,
      status: record.status,
      validation: cloneValidation(record.validation),
      progress: progressOf(record),
      chunks: record.chunks.map((chunk) => ({
        index: chunk.index,
        offset: chunk.offset,
        size: chunk.size,
        digest: chunk.digest,
        status: chunk.status,
        attempts: chunk.attempts,
        acknowledgedAt: chunk.acknowledgedAt,
      })),
      serverReceipt: record.serverReceipt
        ? {
            ...record.serverReceipt,
            raw: { ...record.serverReceipt.raw },
          }
        : null,
      attachmentRow: this.attachmentRow(record),
      committed: record.status === "committed",
      cancelled: record.status === "cancelled",
      attemptCount: record.attemptCount,
      lateSuccessesIgnored: record.lateSuccessesIgnored,
      error: record.error ? { ...record.error } : null,
      abortError: record.abortError ? { ...record.abortError } : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      committedAt: record.committedAt,
      cancelledAt: record.cancelledAt,
      metadata: { ...record.metadata },
    };
  }

  private attachmentRow(record: InternalTransaction): AttachmentRow {
    return {
      id: record.uploadId,
      uploadId: record.uploadId,
      fileName: record.fileName,
      name: record.fileName,
      size: record.size,
      mimeType: record.mimeType,
      contentDigest: record.contentDigest,
      status: record.status,
      progress: progressOf(record),
      validation: cloneValidation(record.validation),
      serverReceiptId: record.serverReceipt?.receiptId ?? null,
      attachmentId: record.serverReceipt?.attachmentId ?? null,
      committed: record.status === "committed",
      cancelled: record.status === "cancelled",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private emitProgress(record: InternalTransaction): void {
    const progress = progressOf(record);
    const snapshot = this.snapshot(record);
    try {
      this.onProgress?.(progress, snapshot);
    } catch {}
    this.emit({ type: "progress", snapshot, progress });
  }

  private emitAttachmentRow(record: InternalTransaction): void {
    const row = this.attachmentRow(record);
    try {
      this.onAttachmentRow?.(row);
    } catch {}
    this.emit({ type: "attachment-row", row });
  }

  private emitState(
    record: InternalTransaction,
    previousStatus: UploadTransactionStatus = record.status,
  ): void {
    const snapshot = this.snapshot(record);
    try {
      this.onStateChange?.(snapshot, previousStatus);
    } catch {}
    this.emit({ type: "state", snapshot });
  }

  private emit(event: UploadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private requireRecord(
    uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
  ): InternalTransaction {
    const id = resolveUploadId(uploadId);
    const record = this.records.get(id);
    if (!record) {
      throw new UploadComponentError(
        "unknown_upload",
        `Unknown upload id: ${id}`,
        id,
      );
    }
    return record;
  }

  private nextUploadId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = String(this.idFactory());
      if (id && !this.records.has(id) && !this.issuedIds.has(id)) {
        this.issuedIds.add(id);
        return id;
      }
    }
    throw new UploadComponentError(
      "id_collision",
      "Unable to allocate a unique upload id.",
    );
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export function createUploadTransaction(
  options?: UploadTransactionOptions,
): UploadTransactionComponent;
export function createUploadTransaction(
  transport: UploadTransport,
  options?: UploadTransactionOptions,
): UploadTransactionComponent;
export function createUploadTransaction(
  optionsOrTransport: UploadTransactionOptions | UploadTransport = {},
  extraOptions: UploadTransactionOptions = {},
): UploadTransactionComponent {
  if (isUploadTransport(optionsOrTransport)) {
    return new UploadTransactionComponent(optionsOrTransport, extraOptions);
  }
  return new UploadTransactionComponent(optionsOrTransport);
}

export async function uploadFile(
  source: UploadSource | File | Blob,
  options: UploadTransactionOptions & SelectFileOptions = {},
): Promise<UploadFileResult> {
  const component = new UploadTransactionComponent(options);
  const transaction = await component.selectFile(source, options);
  if (!transaction.validation.valid) {
    throw new UploadValidationError(
      transaction.uploadId,
      transaction.validation,
    );
  }
  await component.upload(transaction.uploadId);
  return {
    transaction: component.getSnapshot(transaction.uploadId),
    evidence: component.getEvidence(),
  };
}

export function evidenceToJSON(
  evidence: UploadEvidence,
  space: number = 2,
): string {
  return JSON.stringify(evidence, null, space);
}

export { UploadTransactionComponent as UploadTransaction };
export { UploadTransactionComponent as UploadManager };
export { UploadTransactionComponent as UploadComponent };
export { createUploadTransaction as createUploadManager };
export { uploadFile as uploadFileInChunks };
export { uploadFile as uploadChunkedFile };
export default UploadTransactionComponent;

function progressOf(record: InternalTransaction): UploadProgress {
  const acknowledged = record.chunks.filter(
    (chunk) => chunk.status === "acknowledged",
  );
  const uploadedBytes = acknowledged.reduce(
    (total, chunk) => total + chunk.size,
    0,
  );
  const ratio =
    record.size === 0 ? 0 : Math.min(1, uploadedBytes / record.size);
  return {
    uploadedBytes,
    totalBytes: record.size,
    ratio,
    percent: Math.round(ratio * 10000) / 100,
    acknowledgedChunks: acknowledged.length,
    totalChunks: record.chunks.length,
  };
}

function cloneValidation(
  validation: UploadValidationResult,
): UploadValidationResult {
  return {
    valid: validation.valid,
    checks: { ...validation.checks },
    issues: validation.issues.map((issue) => ({ ...issue })),
  };
}

async function readSourceBytes(source: UploadSource): Promise<Uint8Array> {
  const data = source.data;
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data && typeof data.arrayBuffer === "function") {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof source.arrayBuffer === "function") {
    return new Uint8Array(await source.arrayBuffer());
  }
  throw new UploadSourceError(
    "File source must expose data or an arrayBuffer() method.",
  );
}

function fileNameFromBlob(source: unknown): string | undefined {
  const name = (source as File).name;
  return typeof name === "string" ? name : undefined;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new UploadComponentError(
      "crypto_unavailable",
      "Web Crypto SHA-256 support is required.",
    );
  }
  const digest = await subtle.digest(
    "SHA-256",
    data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function defaultUploadId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid) {
    return randomUuid.call(globalThis.crypto);
  }
  const random = Math.random().toString(36).slice(2, 12);
  return `upload_${Date.now().toString(36)}_${random}`;
}

function extensionOf(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0 || lastDot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}

function mimeMatches(allowed: string, actual: string): boolean {
  const expected = allowed.trim().toLowerCase();
  const candidate = actual.trim().toLowerCase();
  if (expected === "*/*" || expected === candidate) {
    return true;
  }
  if (expected.endsWith("/*")) {
    return candidate.startsWith(expected.slice(0, -1));
  }
  return false;
}

function normalizeDigest(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

function normalizeMissingChunks(
  value: unknown,
  record: InternalTransaction,
): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((index) => Number(index))
        .filter(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < record.chunks.length,
        ),
    ),
  ].sort((left, right) => left - right);
}

function isChunkReceiptSuccess(receipt: ChunkReceipt | void): boolean {
  return (
    !receipt ||
    (receipt.accepted !== false &&
      receipt.ok !== false &&
      receipt.status !== "rejected" &&
      receipt.status !== "error")
  );
}

function isServerReceiptSuccess(
  receipt: ServerUploadReceipt | void,
): boolean {
  return (
    !receipt ||
    (receipt.accepted !== false &&
      receipt.ok !== false &&
      receipt.committed !== false &&
      receipt.status !== "rejected" &&
      receipt.status !== "error" &&
      receipt.status !== "failed")
  );
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof UploadComponentError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code:
        typeof (error as Error & { code?: unknown }).code === "string"
          ? String((error as Error & { code?: unknown }).code)
          : "error",
    };
  }
  return {
    name: "Error",
    message: String(error),
    code: "error",
  };
}

function resolveUploadId(
  uploadId: string | Pick<UploadTransactionSnapshot, "uploadId">,
): string {
  return typeof uploadId === "string" ? uploadId : uploadId.uploadId;
}

function isUploadTransport(value: unknown): value is UploadTransport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.uploadChunk === "function" &&
    !("chunkSize" in candidate) &&
    !("validation" in candidate) &&
    !("transport" in candidate) &&
    !("uploader" in candidate) &&
    !("createUploadId" in candidate) &&
    !("now" in candidate) &&
    !("onProgress" in candidate) &&
    !("onAttachmentRow" in candidate) &&
    !("onStateChange" in candidate)
  );
}
