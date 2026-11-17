import { AckRangeSet } from './ack-ranges.ts';
import { frameKey, FrameLedger } from './frame-ledger.ts';
import {
  DEFAULT_GRANULARITY,
  DEFAULT_MAX_ACK_DELAY,
  DEFAULT_TIME_THRESHOLD,
  RttEstimator,
} from './rtt.ts';
import {
  PACKET_NUMBER_SPACES,
  SPACE_ORDER,
  type AckFrameInput,
  type AckResult,
  type Frame,
  type InFlightFrameSnapshot,
  type LostPacket,
  type LossKind,
  type PacketNumberSpace,
  type RecoveryConfig,
  type RecoverySnapshot,
  type RecoveryTimer,
  type SendPacketOptions,
  type SentPacket,
  type SpaceSnapshot,
  type TimerResult,
} from './types.ts';

const DEFAULT_PACKET_THRESHOLD = 3;
const DEFAULT_PROBE_COUNT = 2;

interface PacketRecord {
  readonly packet: SentPacket;
}

interface SpaceState {
  readonly space: PacketNumberSpace;
  nextPacketNumber: number;
  largestSent: number | null;
  largestAcked: number | null;
  lastAckElicitingSentAt: number | null;
  readonly sent: Map<number, PacketRecord>;
  readonly ledger: FrameLedger;
  overheadInFlight: number;
  ptoCount: number;
  lossTime: number | null;
  discarded: boolean;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertPacketNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function normalizeFrame(frame: Frame): Frame {
  if (typeof frame.id !== 'string' && typeof frame.id !== 'number') {
    throw new TypeError('frame id must be a string or number');
  }
  if (typeof frame.id === 'string' && frame.id.length === 0) {
    throw new RangeError('frame id must not be empty');
  }
  if (typeof frame.id === 'number' && !Number.isFinite(frame.id)) {
    throw new RangeError('numeric frame id must be finite');
  }

  assertNonNegativeInteger(frame.size, 'frame size');

  return Object.freeze({
    id: frame.id,
    size: frame.size,
    ackEliciting: frame.ackEliciting ?? true,
    retransmittable: frame.retransmittable ?? true,
  });
}

function comparePackets(a: PacketRecord, b: PacketRecord): number {
  return a.packet.packetNumber - b.packet.packetNumber;
}

function earlierTimer(
  a: RecoveryTimer | null,
  b: RecoveryTimer | null,
): RecoveryTimer | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.at !== b.at) return a.at < b.at ? a : b;

  const spaceOrder = SPACE_ORDER[a.space] - SPACE_ORDER[b.space];
  if (spaceOrder !== 0) return spaceOrder < 0 ? a : b;

  // A loss timer wins a tie with PTO so time-threshold loss detection runs
  // before a probe is scheduled for the same instant.
  if (a.kind !== b.kind) return a.kind === 'loss' ? a : b;
  return a;
}

/**
 * Embeddable QUIC loss recovery (RFC 9002).
 *
 * The component owns recovery state only: packet number spaces, sent-packet
 * records, RTT/PTO state, and an exact frame-level in-flight ledger.  It does
 * not encode packets or own a congestion controller.
 */
export class QuicRecovery {
  readonly #rtt: RttEstimator;
  readonly #packetThreshold: number;
  readonly #probeCount: number;
  readonly #maxAckDelay: number;
  readonly #spaces: Record<PacketNumberSpace, SpaceState>;

  #handshakeConfirmed: boolean;
  #lastNow = -Infinity;

  constructor(config: RecoveryConfig = {}) {
    assertNonNegativeInteger(
      config.packetThreshold ?? DEFAULT_PACKET_THRESHOLD,
      'packetThreshold',
    );
    assertNonNegativeInteger(
      config.probeCount ?? DEFAULT_PROBE_COUNT,
      'probeCount',
    );

    this.#rtt = new RttEstimator({
      initialRtt: config.initialRtt,
      granularity: config.granularity ?? DEFAULT_GRANULARITY,
      maxAckDelay: config.maxAckDelay ?? DEFAULT_MAX_ACK_DELAY,
      timeThreshold: config.timeThreshold ?? DEFAULT_TIME_THRESHOLD,
    });
    this.#packetThreshold = config.packetThreshold ?? DEFAULT_PACKET_THRESHOLD;
    this.#probeCount = config.probeCount ?? DEFAULT_PROBE_COUNT;
    this.#maxAckDelay = config.maxAckDelay ?? DEFAULT_MAX_ACK_DELAY;
    this.#handshakeConfirmed = config.handshakeConfirmed ?? false;

    const spaces = {} as Record<PacketNumberSpace, SpaceState>;
    for (const space of PACKET_NUMBER_SPACES) {
      spaces[space] = {
        space,
        nextPacketNumber: 0,
        largestSent: null,
        largestAcked: null,
        lastAckElicitingSentAt: null,
        sent: new Map(),
        ledger: new FrameLedger(),
        overheadInFlight: 0,
        ptoCount: 0,
        lossTime: null,
        discarded: false,
      };
    }
    this.#spaces = spaces;
  }

  get handshakeConfirmed(): boolean {
    return this.#handshakeConfirmed;
  }

  get rtt(): RttEstimator {
    return this.#rtt;
  }

  get bytesInFlight(): number {
    return this.getBytesInFlight();
  }

  /** Snake-case alias matching the RFC variable name. */
  get bytes_in_flight(): number {
    return this.getBytesInFlight();
  }

  #space(space: PacketNumberSpace): SpaceState {
    const state = this.#spaces[space];
    if (state === undefined) {
      throw new RangeError(`unknown packet number space: ${String(space)}`);
    }
    return state;
  }

  #advanceTime(now: number): void {
    assertTime(now, 'now');
    if (now < this.#lastNow) {
      throw new RangeError(
        `time moved backwards: ${now} < ${this.#lastNow}`,
      );
    }
    this.#lastNow = now;
  }

  #consumePacket(
    state: SpaceState,
    record: PacketRecord,
    operation: 'acknowledge' | 'lose',
  ): void {
    for (const frame of record.packet.frames) {
      if (operation === 'acknowledge') {
        state.ledger.acknowledge(record.packet.packetNumber, frame);
      } else {
        state.ledger.lose(record.packet.packetNumber, frame);
      }
    }

    state.overheadInFlight -= record.packet.overheadBytes;
    state.sent.delete(record.packet.packetNumber);
  }

  sendPacket(options: SendPacketOptions): SentPacket {
    this.#advanceTime(options.now);
    const state = this.#space(options.space);
    if (state.discarded) {
      throw new Error(`packet number space ${options.space} was discarded`);
    }

    if (!Array.isArray(options.frames)) {
      throw new TypeError('frames must be an array');
    }

    const frames = options.frames.map(normalizeFrame);
    const seen = new Set<string>();
    let frameBytes = 0;
    for (const frame of frames) {
      const key = frameKey(frame.id);
      if (seen.has(key)) {
        throw new RangeError(`duplicate frame id in one packet: ${key}`);
      }
      seen.add(key);
      frameBytes += frame.size;

      const previousSize = state.ledger.sizeOf(key);
      if (previousSize !== undefined && previousSize !== frame.size) {
        throw new RangeError(
          `frame ${key} was retransmitted with a different size`,
        );
      }
    }
    assertNonNegativeInteger(frameBytes, 'total frame bytes');

    const overheadBytes = options.overheadBytes ?? 0;
    assertNonNegativeInteger(overheadBytes, 'overheadBytes');
    const wireBytes = frameBytes + overheadBytes;
    assertNonNegativeInteger(wireBytes, 'packet bytes');

    let packetNumber: number;
    if (options.packetNumber === undefined) {
      packetNumber = state.nextPacketNumber;
    } else {
      assertPacketNumber(options.packetNumber, 'packetNumber');
      if (
        state.largestSent !== null &&
        options.packetNumber <= state.largestSent
      ) {
        throw new RangeError(
          `packetNumber ${options.packetNumber} must exceed largest sent ${state.largestSent}`,
        );
      }
      packetNumber = options.packetNumber;
    }

    if (packetNumber === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('packet number space exhausted');
    }
    state.nextPacketNumber = packetNumber + 1;
    state.largestSent =
      state.largestSent === null
        ? packetNumber
        : Math.max(state.largestSent, packetNumber);

    const ackEliciting = frames.some(
      (frame) => frame.ackEliciting !== false,
    );

    const packet: SentPacket = Object.freeze({
      packetNumber,
      space: options.space,
      sentAt: options.now,
      frames: Object.freeze(frames),
      ackEliciting,
      wireBytes,
      overheadBytes,
    });

    if (!ackEliciting) {
      return packet;
    }

    for (const frame of frames) {
      state.ledger.add(packetNumber, frame);
    }
    state.overheadInFlight += overheadBytes;
    state.sent.set(packetNumber, { packet });
    state.lastAckElicitingSentAt = options.now;

    return packet;
  }

  onAckReceived(input: AckFrameInput): AckResult {
    this.#advanceTime(input.now);
    if (input.ackDelay !== undefined) {
      assertNonNegativeFinite(input.ackDelay, 'ackDelay');
    }
    const ranges = new AckRangeSet(input.ranges);
    const state = this.#space(input.space);

    if (state.discarded) {
      return this.#emptyAckResult(input.space);
    }

    if (state.largestSent === null) {
      throw new RangeError(`ACK received for ${input.space}, but nothing was sent`);
    }
    if (ranges.largest > state.largestSent) {
      throw new RangeError(
        `ACK acknowledges unsent packet ${ranges.largest} in ${input.space}`,
      );
    }

    state.largestAcked =
      state.largestAcked === null
        ? ranges.largest
        : Math.max(state.largestAcked, ranges.largest);

    const newlyAcked = [...state.sent.values()]
      .filter((record) => ranges.has(record.packet.packetNumber))
      .sort(comparePackets);

    let rttSample: number | null = null;
    if (newlyAcked.length > 0) {
      // Every tracked packet is ack-eliciting.  Sampling the largest newly
      // acknowledged ack-eliciting packet avoids selecting an ACK-only packet
      // that the peer may have delayed.
      const largestNewlyAcked = newlyAcked[newlyAcked.length - 1]!.packet;
      rttSample = input.now - largestNewlyAcked.sentAt;
      this.#rtt.update(
        rttSample,
        input.ackDelay ?? 0,
        input.space === 'application' && this.#handshakeConfirmed,
      );
    }

    for (const record of newlyAcked) {
      this.#consumePacket(state, record, 'acknowledge');
    }
    if (newlyAcked.length > 0) {
      state.ptoCount = 0;
    }

    const lost = this.#detectLosses(state, input.now);

    return {
      space: input.space,
      newlyAcked: newlyAcked.map((record) => record.packet),
      lost,
      rttSample,
      rtt: this.#rtt.snapshot(),
      timer: this.getTimer(),
      bytesInFlight: this.getBytesInFlight(),
    };
  }

  #emptyAckResult(space: PacketNumberSpace): AckResult {
    return {
      space,
      newlyAcked: [],
      lost: [],
      rttSample: null,
      rtt: this.#rtt.snapshot(),
      timer: this.getTimer(),
      bytesInFlight: this.getBytesInFlight(),
    };
  }

  #detectLosses(
    state: SpaceState,
    now: number,
  ): readonly LostPacket[] {
    if (state.discarded || state.largestAcked === null) {
      state.lossTime = null;
      return [];
    }

    const lossDelay = this.#rtt.lossDelay;
    const lost: LostPacket[] = [];
    const records = [...state.sent.values()].sort(comparePackets);

    for (const record of records) {
      const packetNumber = record.packet.packetNumber;
      if (packetNumber >= state.largestAcked) {
        continue;
      }

      const byPacketThreshold =
        state.largestAcked - packetNumber >= this.#packetThreshold;
      const byTimeThreshold =
        record.packet.sentAt + lossDelay <= now;

      if (!byPacketThreshold && !byTimeThreshold) {
        continue;
      }

      const lostBy: LossKind = byPacketThreshold
        ? 'packet-threshold'
        : 'time-threshold';
      this.#consumePacket(state, record, 'lose');
      lost.push({ ...record.packet, lostBy });
    }

    let lossTime: number | null = null;
    for (const record of state.sent.values()) {
      if (record.packet.packetNumber >= state.largestAcked) {
        continue;
      }
      const candidate = record.packet.sentAt + lossDelay;
      lossTime = lossTime === null ? candidate : Math.min(lossTime, candidate);
    }
    state.lossTime = lossTime;

    return lost;
  }

  detectLostPackets(
    space: PacketNumberSpace,
    now: number,
  ): readonly LostPacket[] {
    this.#advanceTime(now);
    return this.#detectLosses(this.#space(space), now);
  }

  #lossTimer(): RecoveryTimer | null {
    let timer: RecoveryTimer | null = null;
    for (const space of PACKET_NUMBER_SPACES) {
      const state = this.#spaces[space];
      if (state.discarded || state.lossTime === null) {
        continue;
      }
      timer = earlierTimer(timer, {
        kind: 'loss',
        at: state.lossTime,
        space,
      });
    }
    return timer;
  }

  #ptoForSpace(space: PacketNumberSpace): RecoveryTimer | null {
    const state = this.#spaces[space];
    if (
      state.discarded ||
      state.sent.size === 0 ||
      state.lastAckElicitingSentAt === null
    ) {
      return null;
    }
    if (space === 'application' && !this.#handshakeConfirmed) {
      return null;
    }

    const base =
      this.#rtt.ptoBase +
      (space === 'application' ? this.#maxAckDelay : 0);
    const multiplier = 2 ** Math.min(state.ptoCount, 52);
    const at = state.lastAckElicitingSentAt + base * multiplier;

    return {
      kind: 'pto',
      at,
      space,
      ptoCount: state.ptoCount,
      probeCount: this.#probeCount,
    };
  }

  #ptoimer(): RecoveryTimer | null {
    let timer: RecoveryTimer | null = null;
    for (const space of PACKET_NUMBER_SPACES) {
      timer = earlierTimer(timer, this.#ptoForSpace(space));
    }
    return timer;
  }

  /** Loss timer, when armed, has priority over the PTO timer. */
  getTimer(): RecoveryTimer | null {
    return this.#lossTimer() ?? this.#ptoimer();
  }

  onTimer(now: number): TimerResult {
    this.#advanceTime(now);

    const lossTimer = this.#lossTimer();
    if (lossTimer !== null) {
      if (lossTimer.at > now) {
        return {
          kind: 'none',
          now,
          timer: lossTimer,
          bytesInFlight: this.getBytesInFlight(),
        };
      }

      const lost: LostPacket[] = [];
      for (const space of PACKET_NUMBER_SPACES) {
        const state = this.#spaces[space];
        if (
          !state.discarded &&
          state.lossTime !== null &&
          state.lossTime <= now
        ) {
          lost.push(...this.#detectLosses(state, now));
        }
      }

      return {
        kind: 'loss',
        now,
        lost,
        timer: this.getTimer(),
        bytesInFlight: this.getBytesInFlight(),
      };
    }

    const ptoTimer = this.#ptoimer();
    if (ptoTimer !== null && ptoTimer.at <= now) {
      const state = this.#spaces[ptoTimer.space];
      state.ptoCount += 1;

      return {
        kind: 'pto',
        now,
        space: ptoTimer.space,
        ptoCount: state.ptoCount,
        probeCount: this.#probeCount,
        timer: this.getTimer(),
        bytesInFlight: this.getBytesInFlight(),
      };
    }

    return {
      kind: 'none',
      now,
      timer: this.getTimer(),
      bytesInFlight: this.getBytesInFlight(),
    };
  }

  confirmHandshake(): RecoveryTimer | null {
    this.#handshakeConfirmed = true;
    return this.getTimer();
  }

  discardSpace(space: PacketNumberSpace): readonly SentPacket[] {
    const state = this.#space(space);
    if (state.discarded) {
      return [];
    }

    const discarded = [...state.sent.values()]
      .sort(comparePackets)
      .map((record) => record.packet);

    state.ledger.clear();
    state.overheadInFlight = 0;
    state.sent.clear();
    state.lossTime = null;
    state.ptoCount = 0;
    state.discarded = true;
    return discarded;
  }

  getBytesInFlight(space?: PacketNumberSpace): number {
    if (space !== undefined) {
      const state = this.#space(space);
      return state.ledger.bytes + state.overheadInFlight;
    }

    let total = 0;
    for (const name of PACKET_NUMBER_SPACES) {
      total += this.getBytesInFlight(name);
    }
    return total;
  }

  getSentPackets(space: PacketNumberSpace): readonly SentPacket[] {
    return this.getOutstandingPackets(space);
  }

  getOutstandingPackets(
    space: PacketNumberSpace,
  ): readonly SentPacket[] {
    return [...this.#space(space).sent.values()]
      .sort(comparePackets)
      .map((record) => record.packet);
  }

  /**
   * Returns each logical frame that currently contributes bytes once, with
   * every packet number still carrying a copy.  A frame acknowledged in any
   * copy is omitted even if duplicate copies remain outstanding.
   */
  getInFlightFrames(
    space: PacketNumberSpace,
  ): readonly InFlightFrameSnapshot[] {
    return this.#space(space)
      .ledger.snapshot()
      .filter((entry) => !entry.delivered)
      .map((entry) => ({
        id: entry.id,
        size: entry.size,
        copies: entry.copies,
      }));
  }

  getSpaceSnapshot(space: PacketNumberSpace): SpaceSnapshot {
    const state = this.#space(space);
    return {
      space,
      nextPacketNumber: state.nextPacketNumber,
      largestSent: state.largestSent,
      largestAcked: state.largestAcked,
      outstandingPackets: state.sent.size,
      bytesInFlight: this.getBytesInFlight(space),
      ptoCount: state.ptoCount,
      lossTime: state.lossTime,
      discarded: state.discarded,
    };
  }

  snapshot(): RecoverySnapshot {
    const spaces = {} as Record<PacketNumberSpace, SpaceSnapshot>;
    for (const space of PACKET_NUMBER_SPACES) {
      spaces[space] = this.getSpaceSnapshot(space);
    }
    return {
      bytesInFlight: this.getBytesInFlight(),
      rtt: this.#rtt.snapshot(),
      timer: this.getTimer(),
      spaces,
    };
  }

  /**
   * Cheap structural check intended for tests and debug builds.  It verifies
   * the in-flight ledger, packet references, and the global sum invariant.
   */
  checkInvariants(): readonly string[] {
    const errors: string[] = [];
    let total = 0;

    for (const space of PACKET_NUMBER_SPACES) {
      const state = this.#spaces[space];
      const ledger = state.ledger.snapshot();
      const ledgerByKey = new Map(ledger.map((entry) => [entry.key, entry]));
      const overhead = [...state.sent.values()].reduce(
        (sum, record) => sum + record.packet.overheadBytes,
        0,
      );
      const expectedBytes = state.ledger.bytes + overhead;
      const actualBytes = this.getBytesInFlight(space);
      total += actualBytes;
      const recomputedLedgerBytes = ledger
        .filter((entry) => !entry.delivered)
        .reduce((sum, entry) => sum + entry.size, 0);

      if (actualBytes !== expectedBytes) {
        errors.push(
          `${space}: bytesInFlight ${actualBytes} != ledger ${state.ledger.bytes} + overhead ${overhead}`,
        );
      }
      if (state.overheadInFlight !== overhead) {
        errors.push(
          `${space}: cached overhead ${state.overheadInFlight} != ${overhead}`,
        );
      }
      if (state.ledger.bytes !== recomputedLedgerBytes) {
        errors.push(
          `${space}: ledger bytes ${state.ledger.bytes} != ${recomputedLedgerBytes}`,
        );
      }

      for (const entry of ledger) {
        if (entry.copies.length === 0) {
          errors.push(`${space}: ledger frame ${entry.key} has no copies`);
        }
        for (const packetNumber of entry.copies) {
          const record = state.sent.get(packetNumber);
          if (record === undefined) {
            errors.push(
              `${space}: ledger ${entry.key} references missing packet ${packetNumber}`,
            );
            continue;
          }
          const present = record.packet.frames.some(
            (frame) => frameKey(frame.id) === entry.key,
          );
          if (!present) {
            errors.push(
              `${space}: ledger ${entry.key} references packet ${packetNumber} without that frame`,
            );
          }
        }
      }

      for (const [packetNumber, record] of state.sent) {
        if (record.packet.packetNumber !== packetNumber) {
          errors.push(`${space}: packet map key ${packetNumber} mismatch`);
        }
        if (!record.packet.ackEliciting) {
          errors.push(
            `${space}: non-ack-eliciting packet ${packetNumber} is tracked as in flight`,
          );
        }

        const seen = new Set<string>();
        for (const frame of record.packet.frames) {
          const key = frameKey(frame.id);
          if (seen.has(key)) {
            errors.push(
              `${space}: duplicate frame ${key} in packet ${packetNumber}`,
            );
          }
          seen.add(key);

          const entry = ledgerByKey.get(key);
          if (entry === undefined || !entry.copies.includes(packetNumber)) {
            errors.push(
              `${space}: packet ${packetNumber} frame ${key} missing from ledger`,
            );
          }
        }
      }

      const lossTime = state.lossTime;
      if (lossTime !== null && state.largestAcked === null) {
        errors.push(`${space}: lossTime set without largestAcked`);
      }
    }

    if (total !== this.getBytesInFlight()) {
      errors.push(
        `global bytesInFlight ${this.getBytesInFlight()} != per-space sum ${total}`,
      );
    }

    return errors;
  }

  assertInvariants(): void {
    const errors = this.checkInvariants();
    if (errors.length > 0) {
      throw new Error(`recovery invariant violation:\n${errors.join('\n')}`);
    }
  }
}
