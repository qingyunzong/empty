import { EventLog, type Event, type PermissionEffect } from './events.js';

export interface PermissionState {
  version: number;
  effect: PermissionEffect;
  sourceEventSeq: number;
}

export function resolvePermission(
  events: readonly Event[],
  subject: string,
  resource: string,
  beforeSeq: number,
): PermissionState | null {
  let state: PermissionState | null = null;
  for (const event of events) {
    if (event.seq >= beforeSeq) break;
    if (
      (event.kind === 'permission.grant' || event.kind === 'permission.revoke') &&
      event.subject === subject &&
      event.resource === resource
    ) {
      state = {
        version: event.permissionVersion,
        effect: event.kind === 'permission.grant' ? 'allow' : 'deny',
        sourceEventSeq: event.seq,
      };
    }
  }
  return state;
}

export function permissionEventSeqs(
  events: readonly Event[],
  subject: string,
  resource: string,
  beforeSeq: number,
): number[] {
  const seqs: number[] = [];
  for (const event of events) {
    if (event.seq >= beforeSeq) break;
    if (
      (event.kind === 'permission.grant' || event.kind === 'permission.revoke') &&
      event.subject === subject &&
      event.resource === resource
    ) {
      seqs.push(event.seq);
    }
  }
  return seqs;
}

export class PermissionLedger {
  private versionCounter = 0;

  constructor(private readonly log: EventLog) {}

  get currentVersion(): number {
    return this.versionCounter;
  }

  grant(tick: number, subject: string, resource: string): Event {
    this.versionCounter += 1;
    return this.log.append(tick, {
      kind: 'permission.grant',
      subject,
      resource,
      permissionVersion: this.versionCounter,
    });
  }

  revoke(tick: number, subject: string, resource: string): Event {
    this.versionCounter += 1;
    return this.log.append(tick, {
      kind: 'permission.revoke',
      subject,
      resource,
      permissionVersion: this.versionCounter,
    });
  }

  effectNow(subject: string, resource: string): PermissionState | null {
    return resolvePermission(this.log.all(), subject, resource, Number.MAX_SAFE_INTEGER);
  }
}
