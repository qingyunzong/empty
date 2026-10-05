import { createHash } from "node:crypto";
import type { World } from "./model";

/** 键序稳定的 JSON 序列化，保证同一状态得到同一摘要。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",");
  return `{${body}}`;
}

export interface StateCertificate {
  eventCount: number;
  lastSeq: number;
  ledgerEntries: number;
  orders: Record<string, string>;
  materials: Record<string, Record<string, number>>;
  equipmentBusy: Record<string, string | null>;
  sha256: string;
}

/** 由世界状态生成状态证书（含内容寻址哈希）。 */
export function certify(world: World): StateCertificate {
  const orders: Record<string, string> = {};
  for (const [id, order] of Object.entries(world.orders)) orders[id] = order.status;
  const materials: Record<string, Record<string, number>> = {};
  for (const [id, account] of Object.entries(world.materials)) materials[id] = { ...account };
  const equipmentBusy: Record<string, string | null> = {};
  for (const [id, equipment] of Object.entries(world.equipment)) {
    equipmentBusy[id] = equipment.busyBy ? `${equipment.busyBy.order}/${equipment.busyBy.stage}` : null;
  }
  const body = {
    eventCount: world.seq,
    lastSeq: world.seq,
    ledgerEntries: world.ledger.length,
    orders,
    materials,
    equipmentBusy,
    ledger: world.ledger,
    stages: Object.fromEntries(
      Object.entries(world.orders).map(([id, order]) => [
        id,
        order.stages.map((s) => ({ name: s.name, status: s.status, attempts: s.attempts, retained: s.retained })),
      ]),
    ),
  };
  const sha256 = createHash("sha256").update(canonicalize(body)).digest("hex");
  return {
    eventCount: body.eventCount,
    lastSeq: body.lastSeq,
    ledgerEntries: body.ledgerEntries,
    orders,
    materials,
    equipmentBusy,
    sha256,
  };
}
