import { createHash, type Hash } from "node:crypto";

export type RequestStage = "Request" | "Response";
export type PausedResolution = "continue" | "fulfill" | "fail";

export interface CdpConnectionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface RedirectResponseInfo {
  status: number;
  url?: string;
  headers?: Record<string, string>;
}

export interface RequestPausedEvent {
  requestId: string;
  networkId?: string;
  frameId?: string;
  resourceType?: string;
  requestStage: RequestStage;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
  };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  redirectResponse?: RedirectResponseInfo;
}

export interface PausedRequestInfo {
  interceptionId: string;
  networkRequestId: string | null;
  generation: number;
  redirectHop: number;
  stage: RequestStage;
  url: string;
  method: string;
  resolution: PausedResolution | null;
}

export interface ResponseMetadata {
  interceptionId: string;
  networkRequestId: string | null;
  generation: number;
  redirectHop: number;
  stage: RequestStage;
  url: string;
  method: string;
  status: number | null;
  responseHeaders: Record<string, string>;
}

export interface BodyDigestRecord {
  interceptionId: string;
  networkRequestId: string | null;
  generation: number;
  redirectHop: number;
  sha256: string;
  bytes: number;
}

export interface CaptureConfirmation {
  interceptionId: string;
  networkRequestId: string | null;
  generation: number;
  redirectHop: number;
  confirmedAt: string;
}

export interface CaptureStore {
  persistResponseMetadata(metadata: ResponseMetadata): Promise<void>;
  persistBodyDigest(digest: BodyDigestRecord): Promise<void>;
  confirmCapture(confirmation: CaptureConfirmation): Promise<void>;
}

export class UnknownPausedRequestError extends Error {
  constructor(public readonly interceptionId: string) {
    super(`unknown paused request: ${interceptionId}`);
    this.name = "UnknownPausedRequestError";
  }
}

export class PausedRequestAlreadyResolvedError extends Error {
  constructor(
    public readonly interceptionId: string,
    public readonly resolution: PausedResolution,
  ) {
    super(`paused request ${interceptionId} already resolved with "${resolution}"`);
    this.name = "PausedRequestAlreadyResolvedError";
  }
}

export class StaleGenerationError extends Error {
  constructor(
    public readonly interceptionId: string,
    public readonly recordGeneration: number,
    public readonly currentGeneration: number,
  ) {
    super(
      `paused request ${interceptionId} belongs to navigation generation ${recordGeneration}, ` +
        `current generation is ${currentGeneration}`,
    );
    this.name = "StaleGenerationError";
  }
}

export class BodyStreamNotConsumedError extends Error {
  constructor(public readonly interceptionId: string) {
    super(`body stream for ${interceptionId} has not been fully consumed`);
    this.name = "BodyStreamNotConsumedError";
  }
}

export class CaptureAlreadyConfirmedError extends Error {
  constructor(public readonly interceptionId: string) {
    super(`capture for ${interceptionId} has already been confirmed`);
    this.name = "CaptureAlreadyConfirmedError";
  }
}

interface PausedRecord {
  interceptionId: string;
  networkRequestId: string | null;
  generation: number;
  redirectHop: number;
  stage: RequestStage;
  event: RequestPausedEvent;
  resolution: PausedResolution | null;
}

interface IoReadResult {
  data: string;
  eof: boolean;
  base64Encoded?: boolean;
}

export class CdpBodyStream implements AsyncIterable<Buffer> {
  readonly interceptionId: string;
  readonly networkRequestId: string | null;
  readonly generation: number;
  readonly redirectHop: number;

  #connection: CdpConnectionLike;
  #handle: string;
  #hash: Hash = createHash("sha256");
  #bytes = 0;
  #eof = false;
  #closed = false;

  constructor(
    connection: CdpConnectionLike,
    handle: string,
    binding: { interceptionId: string; networkRequestId: string | null; generation: number; redirectHop: number },
  ) {
    this.#connection = connection;
    this.#handle = handle;
    this.interceptionId = binding.interceptionId;
    this.networkRequestId = binding.networkRequestId;
    this.generation = binding.generation;
    this.redirectHop = binding.redirectHop;
  }

  get consumed(): boolean {
    return this.#eof;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get bytesRead(): number {
    return this.#bytes;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    while (!this.#eof) {
      if (this.#closed) {
        throw new Error(`body stream ${this.#handle} was closed before EOF`);
      }
      const chunk = await this.#connection.send<IoReadResult>("IO.read", { handle: this.#handle });
      const data = chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64")
        : Buffer.from(chunk.data, "utf8");
      this.#hash.update(data);
      this.#bytes += data.length;
      if (chunk.eof) {
        this.#eof = true;
        await this.close();
      }
      if (data.length > 0) {
        yield data;
      }
    }
  }

  digestHex(): string | null {
    return this.#eof ? this.#hash.digest("hex") : null;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#connection.send("IO.close", { handle: this.#handle });
  }
}

export interface FulfillParams {
  responseCode: number;
  responseHeaders?: Array<{ name: string; value: string }>;
  body?: string;
  responsePhrase?: string;
}

export class FetchInterceptionCoordinator {
  #connection: CdpConnectionLike;
  #store: CaptureStore;
  #generation = 0;
  #paused = new Map<string, PausedRecord>();
  #redirectHops = new Map<string, number>();
  #streams = new Map<string, CdpBodyStream>();
  #confirmed = new Set<string>();

  constructor(deps: { connection: CdpConnectionLike; store: CaptureStore }) {
    this.#connection = deps.connection;
    this.#store = deps.store;
  }

  get generation(): number {
    return this.#generation;
  }

  async beginNavigation(): Promise<number> {
    await this.#teardownGeneration(this.#generation, "superseded-by-navigation");
    this.#generation += 1;
    return this.#generation;
  }

  handleRequestPaused(event: RequestPausedEvent): PausedRequestInfo {
    const networkRequestId = event.networkId ?? null;
    let redirectHop = 0;
    if (networkRequestId !== null) {
      const hopKey = `${this.#generation}:${networkRequestId}`;
      redirectHop = this.#redirectHops.get(hopKey) ?? 0;
      if (event.redirectResponse) {
        this.#redirectHops.set(hopKey, redirectHop + 1);
      }
    }
    const record: PausedRecord = {
      interceptionId: event.requestId,
      networkRequestId,
      generation: this.#generation,
      redirectHop,
      stage: event.requestStage,
      event,
      resolution: null,
    };
    this.#paused.set(event.requestId, record);
    return this.#toInfo(record);
  }

  pausedRequest(interceptionId: string): PausedRequestInfo | null {
    const record = this.#paused.get(interceptionId);
    return record ? this.#toInfo(record) : null;
  }

  async continueRequest(interceptionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
    const record = this.#claimResolution(interceptionId, "continue");
    await this.#connection.send("Fetch.continueRequest", {
      requestId: record.interceptionId,
      ...overrides,
    });
  }

  async fulfillRequest(interceptionId: string, params: FulfillParams): Promise<void> {
    const record = this.#claimResolution(interceptionId, "fulfill");
    await this.#connection.send("Fetch.fulfillRequest", {
      requestId: record.interceptionId,
      responseCode: params.responseCode,
      ...(params.responseHeaders ? { responseHeaders: params.responseHeaders } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.responsePhrase ? { responsePhrase: params.responsePhrase } : {}),
    });
  }

  async failRequest(interceptionId: string, errorReason = "Aborted"): Promise<void> {
    const record = this.#claimResolution(interceptionId, "fail");
    await this.#connection.send("Fetch.failRequest", {
      requestId: record.interceptionId,
      errorReason,
    });
  }

  async openBodyStream(interceptionId: string): Promise<CdpBodyStream> {
    const record = this.#requireCurrentRecord(interceptionId);
    const existing = this.#streams.get(interceptionId);
    if (existing) {
      return existing;
    }
    const { stream } = await this.#connection.send<{ stream: string }>(
      "Fetch.takeResponseBodyAsStream",
      { requestId: record.interceptionId },
    );
    const bodyStream = new CdpBodyStream(this.#connection, stream, {
      interceptionId: record.interceptionId,
      networkRequestId: record.networkRequestId,
      generation: record.generation,
      redirectHop: record.redirectHop,
    });
    this.#streams.set(interceptionId, bodyStream);
    return bodyStream;
  }

  async finalizeCapture(interceptionId: string): Promise<CaptureConfirmation> {
    const record = this.#requireCurrentRecord(interceptionId);
    if (this.#confirmed.has(interceptionId)) {
      throw new CaptureAlreadyConfirmedError(interceptionId);
    }
    const stream = this.#streams.get(interceptionId);
    const sha256 = stream?.digestHex();
    if (!stream || sha256 === null || sha256 === undefined) {
      throw new BodyStreamNotConsumedError(interceptionId);
    }
    const metadata: ResponseMetadata = {
      interceptionId: record.interceptionId,
      networkRequestId: record.networkRequestId,
      generation: record.generation,
      redirectHop: record.redirectHop,
      stage: record.stage,
      url: record.event.request.url,
      method: record.event.request.method,
      status: record.event.responseStatusCode ?? null,
      responseHeaders: Object.fromEntries(
        (record.event.responseHeaders ?? []).map((header) => [header.name, header.value]),
      ),
    };
    const digest: BodyDigestRecord = {
      interceptionId: record.interceptionId,
      networkRequestId: record.networkRequestId,
      generation: record.generation,
      redirectHop: record.redirectHop,
      sha256,
      bytes: stream.bytesRead,
    };
    await this.#store.persistResponseMetadata(metadata);
    await this.#store.persistBodyDigest(digest);
    const confirmation: CaptureConfirmation = {
      interceptionId: record.interceptionId,
      networkRequestId: record.networkRequestId,
      generation: record.generation,
      redirectHop: record.redirectHop,
      confirmedAt: new Date().toISOString(),
    };
    await this.#store.confirmCapture(confirmation);
    this.#confirmed.add(interceptionId);
    return confirmation;
  }

  async cancelGeneration(reason = "page-cancelled"): Promise<void> {
    await this.#teardownGeneration(this.#generation, reason);
  }

  async #teardownGeneration(generation: number, _reason: string): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    for (const stream of this.#streams.values()) {
      if (stream.generation === generation && !stream.consumed && !stream.closed) {
        pending.push(stream.close().catch(() => undefined));
      }
    }
    for (const record of this.#paused.values()) {
      if (record.generation === generation && record.resolution === null) {
        record.resolution = "fail";
        pending.push(
          this.#connection
            .send("Fetch.failRequest", { requestId: record.interceptionId, errorReason: "Aborted" })
            .catch(() => undefined),
        );
      }
    }
    await Promise.all(pending);
  }

  #requireCurrentRecord(interceptionId: string): PausedRecord {
    const record = this.#paused.get(interceptionId);
    if (!record) {
      throw new UnknownPausedRequestError(interceptionId);
    }
    if (record.generation !== this.#generation) {
      throw new StaleGenerationError(interceptionId, record.generation, this.#generation);
    }
    return record;
  }

  #claimResolution(interceptionId: string, resolution: PausedResolution): PausedRecord {
    const record = this.#requireCurrentRecord(interceptionId);
    if (record.resolution !== null) {
      throw new PausedRequestAlreadyResolvedError(interceptionId, record.resolution);
    }
    record.resolution = resolution;
    return record;
  }

  #toInfo(record: PausedRecord): PausedRequestInfo {
    return {
      interceptionId: record.interceptionId,
      networkRequestId: record.networkRequestId,
      generation: record.generation,
      redirectHop: record.redirectHop,
      stage: record.stage,
      url: record.event.request.url,
      method: record.event.request.method,
      resolution: record.resolution,
    };
  }
}
