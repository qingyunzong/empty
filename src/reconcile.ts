import { TransferEngine } from "./engine.ts";
import type { SimEvent } from "./events.ts";
import { runModel } from "./model.ts";

export interface ReconcileReport {
  ok: boolean;
  mismatches: string[];
}

/**
 * Cross-check the engine against the reference event model:
 *  1. per-event decision and rule must match,
 *  2. final committed chunks and transfer status must match,
 *  3. published history must match.
 */
export function reconcile(events: readonly SimEvent[]): ReconcileReport {
  const engine = new TransferEngine();
  const evidence = engine.runAll(events);
  const model = runModel(events);
  const mismatches: string[] = [];

  if (evidence.length !== model.decisions.length) {
    mismatches.push(
      `evidence count ${evidence.length} != model decision count ${model.decisions.length}`,
    );
  }
  const n = Math.min(evidence.length, model.decisions.length);
  for (let i = 0; i < n; i++) {
    const ev = evidence[i]!;
    const md = model.decisions[i]!;
    if (ev.tick !== md.tick || ev.seq !== md.seq || ev.kind !== md.kind) {
      mismatches.push(
        `event[${i}] identity mismatch: engine t${ev.tick}#${ev.seq} ${ev.kind} vs model t${md.tick}#${md.seq} ${md.kind}`,
      );
      continue;
    }
    if (ev.decision !== md.decision || ev.rule !== md.rule) {
      mismatches.push(
        `t${ev.tick}#${ev.seq} ${ev.kind}: engine ${ev.decision}/${ev.rule} vs model ${md.decision}/${md.rule}`,
      );
    }
  }

  const transferIds = new Set([...Object.keys(model.transfers)]);
  for (const id of transferIds) {
    const mt = model.transfers[id]!;
    const et = engine.getTransfer(id);
    if (!et) {
      mismatches.push(`transfer ${id}: missing in engine`);
      continue;
    }
    const engineChunks = [...et.committed].sort((a, b) => a - b);
    if (et.status !== mt.status) {
      mismatches.push(`transfer ${id}: status engine=${et.status} model=${mt.status}`);
    }
    if (engineChunks.join(",") !== mt.committed.join(",")) {
      mismatches.push(
        `transfer ${id}: chunks engine=[${engineChunks}] model=[${mt.committed}]`,
      );
    }
  }

  for (const [objectId, payloads] of Object.entries(model.published)) {
    const history = engine.getHistory(objectId);
    const enginePayloads = history.map((v) => v.payload);
    if (enginePayloads.join("") !== payloads.join("")) {
      mismatches.push(
        `published ${objectId}: engine=[${enginePayloads}] model=[${payloads}]`,
      );
    }
    history.forEach((v, i) => {
      if (v.version !== i + 1) {
        mismatches.push(`published ${objectId}: non-monotonic version at index ${i}`);
      }
    });
  }

  return { ok: mismatches.length === 0, mismatches };
}
