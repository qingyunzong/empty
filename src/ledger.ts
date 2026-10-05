import type { Event } from './events.js';

export type LedgerKind = 'init' | 'reserve' | 'consume' | 'scrap' | 'return';

/** 物料账分录：只记录引起库存（在库/占用）变动的事件 */
export interface LedgerRow {
  seq: number;
  material: string;
  kind: LedgerKind;
  deltaOnHand: number;
  deltaReserved: number;
  onHand: number;
  reserved: number;
  ref: string;
}

export function buildLedger(events: readonly Event[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const onHand: Record<string, number> = {};
  const reserved: Record<string, number> = {};

  const push = (event: Event, material: string, kind: LedgerKind, dOnHand: number, dReserved: number, ref: string): void => {
    onHand[material] = (onHand[material] ?? 0) + dOnHand;
    reserved[material] = (reserved[material] ?? 0) + dReserved;
    rows.push({
      seq: event.seq,
      material,
      kind,
      deltaOnHand: dOnHand,
      deltaReserved: dReserved,
      onHand: onHand[material] ?? 0,
      reserved: reserved[material] ?? 0,
      ref,
    });
  };

  for (const event of events) {
    switch (event.type) {
      case 'StockInitialized':
        for (const [material, qty] of Object.entries(event.items)) push(event, material, 'init', qty, 0, 'stock');
        break;
      case 'MaterialsReserved':
        for (const [material, qty] of Object.entries(event.reserved)) push(event, material, 'reserve', -qty, qty, event.jobId);
        break;
      case 'StageCompleted':
        for (const [material, qty] of Object.entries(event.consumed)) push(event, material, 'consume', 0, -qty, event.jobId);
        break;
      case 'MaterialsScrapped':
        for (const [material, qty] of Object.entries(event.items)) push(event, material, 'scrap', 0, -qty, event.jobId);
        break;
      case 'MaterialsReturned':
        for (const [material, qty] of Object.entries(event.items)) push(event, material, 'return', qty, -qty, event.jobId);
        break;
      default:
        break;
    }
  }
  return rows;
}

export function formatLedger(rows: readonly LedgerRow[]): string {
  const header = 'seq  material  kind     dOnHand  dReserved  onHand  reserved  ref';
  const lines = rows.map(
    (row) =>
      `${String(row.seq).padEnd(4)} ${row.material.padEnd(9)} ${row.kind.padEnd(8)} ` +
      `${String(row.deltaOnHand).padStart(7)}  ${String(row.deltaReserved).padStart(9)}  ` +
      `${String(row.onHand).padStart(6)}  ${String(row.reserved).padStart(8)}  ${row.ref}`,
  );
  return [header, ...lines].join('\n');
}
