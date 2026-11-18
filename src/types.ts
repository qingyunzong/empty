export type ReservationState = 'reserved' | 'passed';

export type ReleaseReason = 'explicit' | 'timeout';

export interface ReservationSnapshot {
  id: string;
  nodeId: string;
  at: number;
  expiresAt: number;
  state: 'reserved';
}

export type ReserveFailureReason =
  | 'shard_exhausted'
  | 'duplicate'
  | 'invalid'
  | 'closed';

export interface ReserveSuccess {
  ok: true;
  reservation: ReservationSnapshot;
  remaining: number;
}

export interface ReserveFailure {
  ok: false;
  reason: ReserveFailureReason;
  remaining: number;
}

export type ReserveResult = ReserveSuccess | ReserveFailure;

export interface QuotaEventBase {
  nodeId: string;
  seq: number;
  reservationId: string;
  at: number;
}

export interface ReserveEvent extends QuotaEventBase {
  kind: 'reserve';
  expiresAt: number;
}

export interface CommitEvent extends QuotaEventBase {
  kind: 'commit';
}

export interface ReleaseEvent extends QuotaEventBase {
  kind: 'release';
  reason: ReleaseReason;
}

export type QuotaEvent = ReserveEvent | CommitEvent | ReleaseEvent;

export type EmittedQuotaEvent = Distribute<QuotaEvent, 'seq'>;

type Distribute<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export interface NodeStats {
  accepted: number;
  failed: number;
  duplicates: number;
  committed: number;
  releasedExplicit: number;
  releasedTimeout: number;
}

export interface NodeSnapshot {
  id: string;
  shardLimit: number;
  windowMs: number;
  effectiveWindowMs: number;
  now: number;
  activeReservations: number;
  reservedInWindow: number;
  passedInWindow: number;
  remaining: number;
  pendingEvents: number;
  stats: NodeStats;
}
