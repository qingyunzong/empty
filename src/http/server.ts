import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { WebhookError } from "../errors.js";
import type { CommitReceipt, HeaderNames } from "../types.js";
import { DEFAULT_HEADER_NAMES } from "../types.js";
import type { WebhookIngestor } from "../ingestor.js";

export interface WebhookServerOptions {
  /** Route prefix; requests hit `POST <prefix>/:endpointId`. */
  pathPrefix?: string;
  headerNames?: HeaderNames;
  /** Reject bodies larger than this many bytes; defaults to 1 MiB. */
  maxBodyBytes?: number;
}

export interface WebhookErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly deliveryId?: string;
  };
}

export type ReceiptHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  receipt: CommitReceipt,
) => void | Promise<void>;

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Read the raw request body as an exact Buffer, enforcing a size cap. */
export async function readRawBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      req.destroy();
      throw new WebhookError(`Request body exceeds ${maxBodyBytes} bytes`, {
        code: "MALFORMED_ENVELOPE",
        statusCode: 413,
        retryable: false,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function matchEndpointPath(
  pathname: string,
  prefix: string,
): string | null {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const expected = `${normalizedPrefix}/`;
  if (!pathname.startsWith(expected)) return null;
  const segment = pathname.slice(expected.length);
  if (segment.length === 0 || segment.includes("/")) return null;
  return decodeURIComponent(segment);
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.length > 0 ? value.join(",") : null;
  return value ?? null;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof WebhookError) {
    const payload: WebhookErrorResponse = {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.deliveryId ? { deliveryId: error.deliveryId } : {}),
      },
    };
    sendJson(res, error.statusCode, payload);
    return;
  }
  sendJson(res, 500, {
    error: {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : "Unexpected ingestion failure",
      retryable: true,
    },
  });
}

/**
 * Build a framework-agnostic Node HTTP server that exposes one POST route per
 * configured endpoint. Successful responses are emitted only after the
 * ingestion transaction commits, and their payload is the committed receipt
 * (including `committedOffset`).
 */
export function createWebhookRequestHandler(
  ingestor: WebhookIngestor,
  options: WebhookServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const prefix = options.pathPrefix ?? "/webhooks";
  const headerNames = options.headerNames ?? DEFAULT_HEADER_NAMES;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function handleWebhookRequest(req, res) {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported", retryable: false },
        });
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const endpointId = matchEndpointPath(pathname, prefix);
      if (endpointId === null) {
        sendJson(res, 404, {
          error: { code: "NOT_FOUND", message: `Routes are mounted under ${prefix}/:endpointId`, retryable: false },
        });
        return;
      }

      const deliveryId = headerValue(req, headerNames.deliveryId);
      const rawTimestamp = headerValue(req, headerNames.timestamp);
      const signatureHeader = headerValue(req, headerNames.signature);
      if (!deliveryId || !rawTimestamp || !signatureHeader) {
        const missing = [
          !deliveryId && headerNames.deliveryId,
          !rawTimestamp && headerNames.timestamp,
          !signatureHeader && headerNames.signature,
        ].filter((name): name is string => Boolean(name));
        sendJson(res, 401, {
          error: {
            code: "MISSING_ENVELOPE",
            message: `Missing required envelope header(s): ${missing.join(", ")}`,
            retryable: false,
          },
        });
        return;
      }

      const body = await readRawBody(req, maxBodyBytes);
      const receipt = await ingestor.ingest({
        endpointId,
        deliveryId,
        rawTimestamp,
        body,
        signatureHeader,
      });

      // 200 covers both first accept and idempotent duplicate; the receipt's
      // `status` field distinguishes them and always binds a committed offset.
      sendJson(res, 200, receipt);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/**
 * Convenience wrapper producing a ready-to-listen Node server. Environments
 * that own the HTTP lifecycle (or forbid `listen`) can instead call
 * {@link createWebhookRequestHandler} directly.
 */
export function createWebhookServer(
  ingestor: WebhookIngestor,
  options: WebhookServerOptions = {},
): Server {
  return createServer(createWebhookRequestHandler(ingestor, options));
}
