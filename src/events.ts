export type PermissionEffect = 'allow' | 'deny';

export type Decision = 'accepted' | 'rejected';

export interface EventBase {
  seq: number;
  tick: number;
}

export type EventBody =
  | {
      kind: 'permission.grant';
      subject: string;
      resource: string;
      permissionVersion: number;
    }
  | {
      kind: 'permission.revoke';
      subject: string;
      resource: string;
      permissionVersion: number;
    }
  | {
      kind: 'batch.open';
      batchId: string;
      subject: string;
      resource: string;
      boundPermissionVersion: number;
      decision: Decision;
      reason: string;
    }
  | {
      kind: 'batch.block_cached';
      batchId: string;
      blockId: string;
    }
  | {
      kind: 'batch.resume';
      batchId: string;
      decision: Decision;
      reason: string;
    }
  | {
      kind: 'batch.commit';
      batchId: string;
      objectId: string;
      decision: Decision;
      reason: string;
      blockIds: string[];
    }
  | {
      kind: 'object.publish';
      objectId: string;
      objectVersion: number;
      blockIds: string[];
    };

export type Event = EventBase & EventBody;

export type EventKind = EventBody['kind'];

export class EventLog {
  private readonly events: Event[] = [];
  private nextSeq = 1;

  append(tick: number, body: EventBody): Event {
    const event = { seq: this.nextSeq, tick, ...body } as Event;
    this.nextSeq += 1;
    this.events.push(event);
    return event;
  }

  all(): readonly Event[] {
    return this.events;
  }

  ofKind<K extends EventKind>(kind: K): Extract<Event, { kind: K }>[] {
    return this.events.filter((e): e is Extract<Event, { kind: K }> => e.kind === kind);
  }
}
