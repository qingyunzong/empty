import { buildSignatureHeader, signDelivery } from "../src/crypto.js";
import type { EndpointConfig, KeySecret } from "../src/types.js";

export const endpointA: EndpointConfig = {
  id: "endpoint-a",
  keys: [
    { id: "key-2026", secret: "secret-current" },
    { id: "key-2025", secret: "secret-previous" },
  ],
  timestampToleranceMs: 60_000,
};

export const endpointStrict: EndpointConfig = {
  id: "endpoint-strict",
  keys: [{ id: "k1", secret: "tight-secret" }],
  timestampToleranceMs: 5_000,
};

export function signedHeaders(
  key: KeySecret,
  deliveryId: string,
  timestamp: number,
  body: Buffer,
): Record<string, string> {
  return {
    "webhook-delivery-id": deliveryId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signDelivery(key, deliveryId, timestamp, body),
  };
}

export function rotationHeaders(
  keys: readonly KeySecret[],
  deliveryId: string,
  timestamp: number,
  body: Buffer,
): Record<string, string> {
  return {
    "webhook-delivery-id": deliveryId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": buildSignatureHeader(keys, deliveryId, timestamp, body),
  };
}
