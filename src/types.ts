export const PACKET_NUMBER_SPACES = [
  'initial',
  'handshake',
  'application',
] as const;

export type PacketNumberSpace = (typeof PACKET_NUMBER_SPACES)[number];

export const SPACE_ORDER: Readonly<Record<PacketNumberSpace, number>> = {
  initial: 0,
  handshake: 1,
  application: 2,
};

export type FrameId = string | number;

/**
 * A logical, retransmittable QUIC frame.
 *
 * `id` identifies the payload, not a particular transmission.  Sending two
 * packets with the same id models retransmitting the same frame and is
 * deliberately not counted twice in bytes_in_flight.
 */
export interface Frame {
  readonly id: FrameId;
  /** Encoded frame bytes used for in-flight accounting. */
  readonly size: number;
  /** Defaults to true.  ACK/PADDING-style frames set this to false. */
  readonly ackEliciting?: boolean;
  /** Defaults to true.  Lost copies of non-retransmittable frames are not returned. */
  readonly retransmittable?: boolean;
}

export interface SendPacketOptions {
  readonly space: PacketNumberSpace;
  readonly frames: readonly Frame[];
  /** Monotonic time in milliseconds. */
  readonly now: number;
  /**
   * Optional explicit packet number.  When omitted, the next number in this
   * space is used.  Explicit numbers must be greater than the largest sent
   * number in the same space.
   */
  readonly packetNumber?: number;
  /**
   * Non-frame bytes (for example, a caller-computed packet header) attributed
   * to this packet.  Unlike frame bytes, overhead is per packet.
   */
  readonly overheadBytes?: number;
}

export interface SentPacket {
  readonly packetNumber: number;
  readonly space: PacketNumberSpace;
  readonly sentAt: number;
  readonly frames: readonly Frame[];
  readonly ackEliciting: boolean;
  readonly wireBytes: number;
  readonly overheadBytes: number;
}

export interface AckRange {
  readonly smallest: number;
  readonly largest: number;
}

export interface AckFrameInput {
  readonly space: PacketNumberSpace;
  /**
   * ACK ranges may be supplied in any order.  They are normalized to
   * descending, non-overlapping ranges.
   */
  readonly ranges: readonly AckRange[];
  /** Monotonic time in milliseconds at which the ACK was received. */
  readonly now: number;
  /** ACK delay in the same time unit as `now` (milliseconds). */
  readonly ackDelay?: number;
}

export type LossKind = 'packet-threshold' | 'time-threshold';

export interface LostPacket extends SentPacket {
  readonly lostBy: LossKind;
}

export interface RttSnapshot {
  readonly latestRtt: number | null;
  readonly minRtt: number | null;
  readonly smoothedRtt: number;
  readonly rttvar: number;
  readonly hasSample: boolean;
}

export type RecoveryTimer =
  | {
      readonly kind: 'loss';
      readonly at: number;
      readonly space: PacketNumberSpace;
    }
  | {
      readonly kind: 'pto';
      readonly at: number;
      readonly space: PacketNumberSpace;
      readonly ptoCount: number;
      readonly probeCount: number;
    };

export interface AckResult {
  readonly space: PacketNumberSpace;
  readonly newlyAcked: readonly SentPacket[];
  readonly lost: readonly LostPacket[];
  readonly rttSample: number | null;
  readonly rtt: RttSnapshot;
  readonly timer: RecoveryTimer | null;
  readonly bytesInFlight: number;
}

export type TimerResult =
  | {
      readonly kind: 'loss';
      readonly now: number;
      readonly lost: readonly LostPacket[];
      readonly timer: RecoveryTimer | null;
      readonly bytesInFlight: number;
    }
  | {
      readonly kind: 'pto';
      readonly now: number;
      readonly space: PacketNumberSpace;
      readonly ptoCount: number;
      readonly probeCount: number;
      readonly timer: RecoveryTimer | null;
      readonly bytesInFlight: number;
    }
  | {
      readonly kind: 'none';
      readonly now: number;
      readonly timer: RecoveryTimer | null;
      readonly bytesInFlight: number;
    };

export interface RecoveryConfig {
  /** Used before the first RTT sample.  RFC 9002 default: 333 ms. */
  readonly initialRtt?: number;
  /** Timer granularity.  RFC 9002 default: 1 ms. */
  readonly granularity?: number;
  /** Application-space max_ack_delay.  RFC 9002 default: 25 ms. */
  readonly maxAckDelay?: number;
  /** RFC 9002 default packet threshold: 3. */
  readonly packetThreshold?: number;
  /** RFC 9002 time threshold multiplier: 9/8. */
  readonly timeThreshold?: number;
  /** Number of probes to send when PTO fires.  RFC 9002 recommends 2. */
  readonly probeCount?: number;
  /** Application-space PTO stays disabled until the handshake is confirmed. */
  readonly handshakeConfirmed?: boolean;
}

export interface SpaceSnapshot {
  readonly space: PacketNumberSpace;
  readonly nextPacketNumber: number;
  readonly largestSent: number | null;
  readonly largestAcked: number | null;
  readonly outstandingPackets: number;
  readonly bytesInFlight: number;
  readonly ptoCount: number;
  readonly lossTime: number | null;
  readonly discarded: boolean;
}

export interface InFlightFrameSnapshot {
  readonly id: FrameId;
  readonly size: number;
  readonly copies: readonly number[];
}

export interface RecoverySnapshot {
  readonly bytesInFlight: number;
  readonly rtt: RttSnapshot;
  readonly timer: RecoveryTimer | null;
  readonly spaces: Readonly<Record<PacketNumberSpace, SpaceSnapshot>>;
}
