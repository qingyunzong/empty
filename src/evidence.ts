import type { Decision, Event } from './events.js';
import { resolvePermission, type PermissionState } from './permissions.js';

export type DecisionOperation = 'open' | 'resume' | 'commit';

export interface ResolutionEvidence {
  operation: DecisionOperation;
  batchId: string;
  subject: string;
  resource: string;
  tick: number;
  decidedAtSeq: number;
  boundPermissionVersion: number | null;
  effectivePermission: PermissionState | null;
  decision: Decision;
  reason: string;
  consultedEventSeqs: number[];
  objectId?: string;
  blockIds?: string[];
}

export interface ModelCheckResult {
  ok: boolean;
  mismatches: string[];
}

function samePermission(a: PermissionState | null, b: PermissionState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.version === b.version && a.effect === b.effect && a.sourceEventSeq === b.sourceEventSeq;
}

export function checkEvidenceAgainstEventModel(
  events: readonly Event[],
  evidence: ResolutionEvidence,
): ModelCheckResult {
  const mismatches: string[] = [];

  const decisionEvent = events.find((e) => e.seq === evidence.decidedAtSeq);
  if (!decisionEvent) {
    mismatches.push(`decision event seq=${evidence.decidedAtSeq} not found in event log`);
    return { ok: false, mismatches };
  }

  const expectedKind =
    evidence.operation === 'open'
      ? 'batch.open'
      : evidence.operation === 'resume'
        ? 'batch.resume'
        : 'batch.commit';
  if (decisionEvent.kind !== expectedKind) {
    mismatches.push(
      `decision event kind mismatch: expected ${expectedKind}, log has ${decisionEvent.kind}`,
    );
  }
  if (decisionEvent.tick !== evidence.tick) {
    mismatches.push(`tick mismatch: evidence=${evidence.tick}, event=${decisionEvent.tick}`);
  }

  const effective = resolvePermission(events, evidence.subject, evidence.resource, evidence.decidedAtSeq);
  if (!samePermission(effective, evidence.effectivePermission)) {
    mismatches.push(
      `effective permission mismatch: evidence=${JSON.stringify(evidence.effectivePermission)}, ` +
        `model=${JSON.stringify(effective)}`,
    );
  }

  const expectedDecision: Decision = effective !== null && effective.effect === 'allow' ? 'accepted' : 'rejected';
  if (evidence.decision !== expectedDecision) {
    mismatches.push(
      `decision mismatch: evidence=${evidence.decision}, model expects ${expectedDecision}`,
    );
  }
  if (
    (decisionEvent.kind === 'batch.open' ||
      decisionEvent.kind === 'batch.resume' ||
      decisionEvent.kind === 'batch.commit') &&
    decisionEvent.decision !== evidence.decision
  ) {
    mismatches.push(
      `logged decision ${decisionEvent.decision} differs from evidence ${evidence.decision}`,
    );
  }

  const openEvent = events.find(
    (e) => e.kind === 'batch.open' && e.batchId === evidence.batchId && e.seq < evidence.decidedAtSeq,
  );
  if (evidence.operation !== 'open') {
    if (!openEvent || openEvent.kind !== 'batch.open') {
      mismatches.push(`no prior batch.open event for batch ${evidence.batchId}`);
    } else if (openEvent.boundPermissionVersion !== evidence.boundPermissionVersion) {
      mismatches.push(
        `bound permission version mismatch: evidence=${evidence.boundPermissionVersion}, ` +
          `batch.open=${openEvent.boundPermissionVersion}`,
      );
    }
  }

  if (effective !== null && !evidence.consultedEventSeqs.includes(effective.sourceEventSeq)) {
    mismatches.push(
      `consultedEventSeqs missing permission source seq ${effective.sourceEventSeq}`,
    );
  }
  if (openEvent && !evidence.consultedEventSeqs.includes(openEvent.seq)) {
    mismatches.push(`consultedEventSeqs missing batch.open seq ${openEvent.seq}`);
  }

  if (evidence.operation === 'commit') {
    const next = events.find((e) => e.seq === evidence.decidedAtSeq + 1);
    if (evidence.decision === 'accepted') {
      if (!next || next.kind !== 'object.publish') {
        mismatches.push('accepted commit is not immediately followed by object.publish');
      } else {
        if (next.objectId !== evidence.objectId) {
          mismatches.push(
            `publish objectId mismatch: evidence=${evidence.objectId}, event=${next.objectId}`,
          );
        }
        if (JSON.stringify(next.blockIds) !== JSON.stringify(evidence.blockIds ?? [])) {
          mismatches.push(
            `publish blockIds mismatch: evidence=${JSON.stringify(evidence.blockIds)}, ` +
              `event=${JSON.stringify(next.blockIds)}`,
          );
        }
      }
    } else if (next && next.kind === 'object.publish') {
      mismatches.push('rejected commit must not be immediately followed by object.publish');
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
