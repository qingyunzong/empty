import {
  AliasConflictError,
  AliasSwitchUncertainError,
  AliasVerificationError,
  BackfillIncompleteError,
  CatchUpNotConvergedError,
  IndexCoordinationError,
  InvalidCoordinatorStateError,
  OpenGapError,
  SwitchAlreadyAttemptedError,
} from "./errors.js";
import { InMemoryGapJournal } from "./gap-journal.js";
import type {
  AliasSnapshot,
  AliasSwapOutcome,
  BackfillResult,
  BackfillSummary,
  CatchUpSummary,
  CleanupResult,
  CoordinationResult,
  DualWriteGap,
  DualWriteResult,
  GapJournal,
  GapRecoveryResult,
  GenerationLike,
  IndexGenerationCoordinatorOptions,
  ReaderLease,
  RetainedGeneration,
  SourceChange,
  SourceVersion,
  SwitchSummary,
  VerificationOutcome,
} from "./types.js";
import {
  compareSourceVersions,
  maxSourceVersion,
  sourceVersionKey,
} from "./version.js";

export type CoordinatorState =
  | "idle"
  | "backfilling"
  | "backfilled"
  | "catching_up"
  | "ready_to_switch"
  | "switching"
  | "switched"
  | "failed";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_CATCH_UP_ROUNDS = 8;

function generationId(value: GenerationLike): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate =
    value.id ??
    (typeof value.generation === "string" ? value.generation : undefined) ??
    (typeof value.name === "string" ? value.name : undefined);
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  throw new TypeError("createGeneration() returned a generation without an id");
}

function generatedTargetId(now: Date): string {
  const timestamp = now.getTime().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `search-gen-${timestamp}-${random}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isTargetAlias(aliases: AliasSnapshot, target: string): boolean {
  return aliases.read === target && aliases.write === target;
}

function normalizeAliases(aliases: AliasSnapshot): AliasSnapshot {
  return {
    read: aliases.read ?? null,
    write: aliases.write ?? null,
  };
}

function parseDate(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function leaseIsActive(lease: ReaderLease, now: Date): boolean {
  if (lease.active === false) {
    return false;
  }
  if (lease.releasedAt !== null && lease.releasedAt !== undefined) {
    return false;
  }
  const expiresAt = parseDate(lease.expiresAt);
  return expiresAt === null || expiresAt > now.getTime();
}

function normalizeSwapOutcome(
  outcome: AliasSwapOutcome,
  target: string,
): { swapped: boolean; aliases?: AliasSnapshot } {
  if (outcome === undefined || outcome === null) {
    return { swapped: true };
  }

  if (typeof outcome === "boolean") {
    return { swapped: outcome };
  }

  if (
    typeof outcome === "object" &&
    outcome !== null &&
    "read" in outcome &&
    "write" in outcome
  ) {
    const aliases = outcome as AliasSnapshot;
    return { swapped: isTargetAlias(aliases, target), aliases };
  }

  const receipt = outcome as { swapped?: unknown; aliases?: AliasSnapshot };
  if (typeof receipt.swapped === "boolean") {
    return {
      swapped: receipt.swapped,
      ...(receipt.aliases === undefined ? {} : { aliases: receipt.aliases }),
    };
  }
  if (receipt.aliases !== undefined) {
    return {
      swapped: isTargetAlias(receipt.aliases, target),
      aliases: receipt.aliases,
    };
  }

  return {
    swapped: true,
  };
}

function verificationOk(outcome: VerificationOutcome): boolean {
  if (outcome === undefined) {
    return true;
  }
  if (typeof outcome === "boolean") {
    return outcome;
  }
  return outcome.ok;
}

function changeKey(change: SourceChange): string {
  if (change.id !== undefined && change.id !== null) {
    return `id:${String(change.id)}`;
  }

  const documentId =
    change.documentId === undefined || change.documentId === null
      ? ""
      : String(change.documentId);
  const operation =
    change.operation === undefined ? "" : String(change.operation);

  return [
    `v:${sourceVersionKey(change.sourceVersion)}`,
    `d:${documentId}`,
    `o:${operation}`,
  ].join("|");
}

function sortChanges(
  changes: readonly SourceChange[],
  comparator: (left: SourceVersion, right: SourceVersion) => number,
): SourceChange[] {
  return [...changes].sort((left, right) => {
    const versionOrder = comparator(left.sourceVersion, right.sourceVersion);
    if (versionOrder !== 0) {
      return versionOrder;
    }
    return changeKey(left) < changeKey(right)
      ? -1
      : changeKey(left) > changeKey(right)
        ? 1
        : 0;
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The index coordination operation was aborted", "AbortError");
  }
}

/**
 * Coordinates a search-index generation migration:
 *
 * 1. create and fully backfill a target generation;
 * 2. replay changes after the backfill checkpoint in source-version order;
 * 3. optionally dual-write live changes, journaling target failures as gaps;
 * 4. conditionally swap read/write aliases exactly once and verify read-back;
 * 5. retire old generations only after their reader leases have drained.
 */
export class IndexGenerationCoordinator {
  readonly #options: IndexGenerationCoordinatorOptions;
  readonly #gapJournal: GapJournal;
  readonly #comparator: (left: SourceVersion, right: SourceVersion) => number;
  readonly #now: () => Date;
  readonly #pageSize: number;
  readonly #maxCatchUpRounds: number;

  #state: CoordinatorState = "idle";
  #targetGeneration: string | undefined;
  #backfill: BackfillSummary | undefined;
  #caughtUpThrough: SourceVersion | undefined;
  #appliedChanges = 0;
  #aliases: AliasSnapshot | undefined;
  #previousAliases: AliasSnapshot | undefined;
  #switchAttempted = false;
  #switchSummary: SwitchSummary | undefined;
  #retiredGenerations = new Set<string>();
  #runPromise: Promise<CoordinationResult> | undefined;
  #switchPromise: Promise<SwitchSummary> | undefined;

  constructor(options: IndexGenerationCoordinatorOptions) {
    if (options.pageSize !== undefined && options.pageSize <= 0) {
      throw new RangeError("pageSize must be greater than zero");
    }
    if (options.maxCatchUpRounds !== undefined && options.maxCatchUpRounds <= 0) {
      throw new RangeError("maxCatchUpRounds must be greater than zero");
    }

    this.#options = options;
    this.#gapJournal = options.gapJournal ?? new InMemoryGapJournal();
    this.#comparator = options.versionComparator ?? compareSourceVersions;
    this.#now = options.now ?? (() => new Date());
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#maxCatchUpRounds =
      options.maxCatchUpRounds ?? DEFAULT_MAX_CATCH_UP_ROUNDS;
  }

  get state(): CoordinatorState {
    return this.#state;
  }

  get targetGeneration(): string | undefined {
    return this.#targetGeneration;
  }

  get caughtUpThrough(): SourceVersion | undefined {
    return this.#caughtUpThrough;
  }

  async getAliases(): Promise<AliasSnapshot> {
    const aliases = normalizeAliases(await this.#options.backend.getAliases());
    this.#aliases = aliases;
    return aliases;
  }

  async getOpenGaps(): Promise<readonly DualWriteGap[]> {
    if (this.#targetGeneration === undefined) {
      return [];
    }
    return (await this.#gapJournal.list(this.#targetGeneration)).filter(
      (gap) => gap.resolvedAt === undefined,
    );
  }

  /**
   * Runs the complete migration. Concurrent calls share one execution, and a
   * successful migration is returned unchanged to make retries safe.
   */
  async run(): Promise<CoordinationResult> {
    if (this.#state === "switched" && this.#switchSummary !== undefined) {
      const cleanup = await this.cleanupRetiredGenerations();
      return this.#result(cleanup);
    }
    if (this.#runPromise !== undefined) {
      return this.#runPromise;
    }
    if (this.#state !== "idle") {
      throw new InvalidCoordinatorStateError(
        `run() cannot start from coordinator state "${this.#state}"`,
      );
    }

    this.#runPromise = this.#runInternal();
    try {
      return await this.#runPromise;
    } finally {
      this.#runPromise = undefined;
    }
  }

  async #runInternal(): Promise<CoordinationResult> {
    try {
      await this.backfill();
      const catchUp = await this.catchUp();
      if (catchUp.openGapCount > 0) {
        throw new OpenGapError((await this.getOpenGaps()).map((gap) => gap.id));
      }

      if (this.#options.beforeSwitch !== undefined) {
        assertNotAborted(this.#options.signal);
        await this.#options.beforeSwitch({
          generation: this.#targetGeneration!,
          sourceVersion: this.#backfill!.sourceVersion,
          caughtUpThrough: this.#caughtUpThrough!,
        });

        await this.catchUp();
      }

      await this.switchAliases();
      const cleanup = await this.cleanupRetiredGenerations();
      this.#state = "switched";
      return this.#result(cleanup);
    } catch (error) {
      this.#state =
        this.#switchSummary === undefined ? "failed" : "switched";
      throw error;
    }
  }

  async backfill(): Promise<BackfillSummary> {
    if (this.#backfill !== undefined) {
      return this.#backfill;
    }
    if (this.#state !== "idle") {
      throw new InvalidCoordinatorStateError(
        `backfill() cannot start from coordinator state "${this.#state}"`,
      );
    }

    assertNotAborted(this.#options.signal);
    this.#state = "backfilling";

    try {
      const now = this.#now();
      const requestedId =
        this.#options.targetGeneration ?? generatedTargetId(now);

      if (this.#options.backend.createGeneration === undefined) {
        this.#targetGeneration = requestedId;
      } else {
        const created = await this.#options.backend.createGeneration({
          id: requestedId,
          kind: "target",
        });
        this.#targetGeneration =
          created === undefined || created === null
            ? requestedId
            : generationId(created);
      }

      const result = await this.#options.backend.backfill(
        this.#targetGeneration,
        {
          targetGeneration: this.#targetGeneration,
          signal: this.#options.signal,
        },
      );

      assertNotAborted(this.#options.signal);

      const completion = result as
        | (BackfillResult & { complete?: boolean })
        | void;
      if (
        completion?.completed === false ||
        completion?.complete === false
      ) {
        throw new BackfillIncompleteError(
          `Backfill for generation "${this.#targetGeneration}" did not complete`,
        );
      }

      const sourceVersion = this.#resolveBackfillVersion(result);
      this.#backfill = {
        generation: this.#targetGeneration,
        sourceVersion,
      };
      this.#caughtUpThrough = sourceVersion;
      this.#state = "backfilled";
      return this.#backfill;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #resolveBackfillVersion(result: BackfillResult | void): SourceVersion {
    const checkpoint = result as
      | (BackfillResult & {
          version?: SourceVersion;
          checkpoint?: SourceVersion;
        })
      | void;
    const version =
      checkpoint?.sourceVersion ??
      checkpoint?.version ??
      checkpoint?.checkpoint;
    if (version !== undefined) {
      return version;
    }
    throw new IndexCoordinationError(
      "BACKFILL_CHECKPOINT_MISSING",
      "backfill() must return the source version covered by the snapshot",
    );
  }

  async catchUp(): Promise<CatchUpSummary> {
    if (this.#backfill === undefined || this.#targetGeneration === undefined) {
      throw new InvalidCoordinatorStateError(
        "catchUp() requires a completed backfill",
      );
    }
    if (this.#state === "switching" || this.#state === "switched") {
      throw new InvalidCoordinatorStateError(
        `catchUp() cannot run from coordinator state "${this.#state}"`,
      );
    }

    this.#state = "catching_up";
    const startVersion = this.#caughtUpThrough!;

    try {
      let cursor = this.#caughtUpThrough!;
      let converged = false;

      for (let round = 0; round < this.#maxCatchUpRounds; round += 1) {
        assertNotAborted(this.#options.signal);
        const highWatermark =
          this.#options.changeFeed.getHighWatermark === undefined
            ? undefined
            : await this.#options.changeFeed.getHighWatermark();

        cursor = await this.#drainChanges(cursor, highWatermark);
        const latest =
          this.#options.changeFeed.getHighWatermark === undefined
            ? highWatermark
            : await this.#options.changeFeed.getHighWatermark();

        if (
          highWatermark === undefined ||
          latest === undefined ||
          this.#comparator(latest, highWatermark) <= 0
        ) {
          this.#caughtUpThrough =
            highWatermark === undefined
              ? cursor
              : maxSourceVersion(cursor, highWatermark, this.#comparator);
          converged = true;
          break;
        }
      }

      if (!converged) {
        throw new CatchUpNotConvergedError(
          this.#maxCatchUpRounds,
          String(cursor),
        );
      }

      await this.retryOpenGaps();
      const openGaps = await this.getOpenGaps();
      this.#state = "ready_to_switch";
      return {
        fromVersion: startVersion,
        throughVersion: this.#caughtUpThrough!,
        appliedChanges: this.#appliedChanges,
        openGapCount: openGaps.length,
      };
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  async #drainChanges(
    initialCursor: SourceVersion,
    throughVersion: SourceVersion | undefined,
  ): Promise<SourceVersion> {
    let cursor = initialCursor;

    for (;;) {
      assertNotAborted(this.#options.signal);
      const page = await this.#options.changeFeed.readChanges({
        afterVersion: cursor,
        ...(throughVersion === undefined ? {} : { throughVersion }),
        limit: this.#pageSize,
      });

      const pending = page.filter((change) => {
        if (this.#comparator(change.sourceVersion, cursor) <= 0) {
          return false;
        }
        return (
          throughVersion === undefined ||
          this.#comparator(change.sourceVersion, throughVersion) <= 0
        );
      });

      if (pending.length === 0) {
        return cursor;
      }

      const sorted = sortChanges(pending, this.#comparator);
      await this.#applyChanges(sorted, "backfill-catch-up");

      for (const change of sorted) {
        cursor = maxSourceVersion(cursor, change.sourceVersion, this.#comparator);
      }
    }
  }

  async #applyChanges(
    changes: readonly SourceChange[],
    reason: "backfill-catch-up" | "dual-write" | "gap-recovery",
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    assertNotAborted(this.#options.signal);
    await this.#options.backend.applyChanges(
      this.#targetGeneration!,
      changes,
      {
        reason,
        targetGeneration: this.#targetGeneration!,
        signal: this.#options.signal,
      },
    );

    if (reason === "backfill-catch-up") {
      this.#appliedChanges += changes.length;
    }

    const keys = new Set(changes.map(changeKey));
    const matchingGaps = (await this.getOpenGaps())
      .filter((gap) => keys.has(gap.changeKey));
    if (matchingGaps.length > 0) {
      await this.#gapJournal.resolve(matchingGaps.map((gap) => gap.id));
    }
  }

  /**
   * Writes a live change to both the current write generation and the target.
   * A target failure is persisted as a replayable gap instead of being dropped.
   */
  async dualWrite(change: SourceChange): Promise<DualWriteResult> {
    if (this.#targetGeneration === undefined) {
      throw new InvalidCoordinatorStateError(
        "dualWrite() requires the target generation to exist",
      );
    }
    if (this.#state === "failed" || this.#state === "backfilling" || this.#state === "idle") {
      throw new InvalidCoordinatorStateError(
        `dualWrite() cannot run from coordinator state "${this.#state}"`,
      );
    }

    const aliases = await this.getAliases();
    if (aliases.write === null) {
      throw new IndexCoordinationError(
        "DUAL_WRITE_PRIMARY_FAILED",
        "The write alias has no current generation",
      );
    }

    if (aliases.write !== this.#targetGeneration) {
      try {
        await this.#options.backend.applyChanges(
          aliases.write,
          [change],
          {
            reason: "dual-write",
            targetGeneration: this.#targetGeneration,
            signal: this.#options.signal,
          },
        );
      } catch (error) {
        throw new IndexCoordinationError(
          "DUAL_WRITE_PRIMARY_FAILED",
          `Primary write to generation "${aliases.write}" failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }

    try {
      await this.#applyChanges([change], "dual-write");
      return { status: "written" };
    } catch (error) {
      const now = this.#now().toISOString();
      const key = changeKey(change);
      const gapId = `${this.#targetGeneration}:${key}`;
      const existing = (
        await this.getOpenGaps()
      ).find((gap) => gap.id === gapId);
      const gap: DualWriteGap = {
        id: gapId,
        generation: this.#targetGeneration,
        sourceVersion: change.sourceVersion,
        change,
        changeKey: key,
        attempts: (existing?.attempts ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        lastAttemptAt: now,
        lastError: errorMessage(error),
      };

      try {
        await this.#gapJournal.append(gap);
      } catch (journalError) {
        throw new IndexCoordinationError(
          "GAP_PERSISTENCE_FAILED",
          `Target write failed and the recoverable gap could not be persisted: ${errorMessage(journalError)}`,
          { cause: journalError },
        );
      }

      return { status: "gap", gap };
    }
  }

  async retryOpenGaps(): Promise<GapRecoveryResult> {
    if (this.#targetGeneration === undefined) {
      return { recoveredGapIds: [], remainingGapIds: [] };
    }

    const gaps = [...(await this.getOpenGaps())].sort(
      (left, right) => {
        const versionOrder = this.#comparator(
          left.sourceVersion,
          right.sourceVersion,
        );
        if (versionOrder !== 0) {
          return versionOrder;
        }
        return left.changeKey < right.changeKey
          ? -1
          : left.changeKey > right.changeKey
            ? 1
            : 0;
      },
    );

    const recoveredGapIds: string[] = [];
    const remainingGapIds: string[] = [];

    for (const gap of gaps) {
      try {
        await this.#applyChanges([gap.change], "gap-recovery");
        recoveredGapIds.push(gap.id);
      } catch (error) {
        remainingGapIds.push(gap.id);
        const existing = (await this.getOpenGaps())
          .find((candidate) => candidate.id === gap.id);
        if (existing !== undefined) {
          await this.#gapJournal.append({
            ...existing,
            attempts: existing.attempts + 1,
            lastAttemptAt: this.#now().toISOString(),
            lastError: errorMessage(error),
          });
        }
      }
    }

    return { recoveredGapIds, remainingGapIds };
  }

  async retryGaps(): Promise<GapRecoveryResult> {
    return this.retryOpenGaps();
  }

  async switchAliases(): Promise<SwitchSummary> {
    if (this.#switchPromise !== undefined) {
      return this.#switchPromise;
    }
    if (this.#switchSummary !== undefined) {
      return this.#switchSummary;
    }
    if (this.#switchAttempted) {
      throw new SwitchAlreadyAttemptedError();
    }
    if (
      this.#backfill === undefined ||
      this.#targetGeneration === undefined ||
      this.#caughtUpThrough === undefined
    ) {
      throw new InvalidCoordinatorStateError(
        "switchAliases() requires completed backfill and catch-up",
      );
    }
    if (this.#state !== "ready_to_switch" && this.#state !== "catching_up") {
      throw new InvalidCoordinatorStateError(
        `switchAliases() cannot run from coordinator state "${this.#state}"`,
      );
    }

    this.#switchPromise = this.#switchAliasesInternal();
    try {
      return await this.#switchPromise;
    } finally {
      this.#switchPromise = undefined;
    }
  }

  async #switchAliasesInternal(): Promise<SwitchSummary> {
    assertNotAborted(this.#options.signal);

    const openGaps = await this.getOpenGaps();
    if (openGaps.length > 0) {
      throw new OpenGapError(openGaps.map((gap) => gap.id));
    }

    if (this.#options.changeFeed.getHighWatermark !== undefined) {
      const latest = await this.#options.changeFeed.getHighWatermark();
      if (this.#comparator(latest, this.#caughtUpThrough!) > 0) {
        throw new IndexCoordinationError(
          "NOT_CAUGHT_UP",
          `Source advanced to ${String(latest)} after catch-up reached ${String(this.#caughtUpThrough)}`,
        );
      }
    }

    const previousAliases = await this.getAliases();
    if (
      previousAliases.read === null ||
      previousAliases.write === null
    ) {
      throw new AliasConflictError(
        "Both read and write aliases must point at a generation before switching",
      );
    }

    this.#previousAliases = previousAliases;
    this.#state = "switching";
    this.#switchAttempted = true;

    let aliases: AliasSnapshot;
    let swapped = false;

    try {
      const outcome = await this.#options.backend.compareAndSwapAliases(
        previousAliases,
        this.#targetGeneration!,
        {
          targetGeneration: this.#targetGeneration!,
          previousAliases,
          signal: this.#options.signal,
        },
      );
      const normalized = normalizeSwapOutcome(outcome, this.#targetGeneration!);
      swapped = normalized.swapped;
      aliases = normalized.aliases ?? (await this.getAliases());
    } catch (error) {
      const observed = await this.#readAliasesBestEffort();
      if (
        observed !== undefined &&
        isTargetAlias(observed, this.#targetGeneration!)
      ) {
        aliases = observed;
        swapped = true;
      } else {
        throw new AliasSwitchUncertainError(
          "Alias compare-and-swap failed; the aliases may or may not have moved. Refusing to retry the single-shot switch.",
          { cause: error },
        );
      }
    }

    if (!swapped || !isTargetAlias(aliases, this.#targetGeneration!)) {
      throw new AliasConflictError(
        `Conditional alias swap was rejected; expected read/write=${previousAliases.read}/${previousAliases.write}`,
      );
    }

    this.#aliases = aliases;

    try {
      await this.#verifyTarget();
    } catch (error) {
      this.#state = "failed";
      throw error;
    }

    for (const generation of [
      previousAliases.read,
      previousAliases.write,
    ]) {
      if (generation !== this.#targetGeneration) {
        this.#retiredGenerations.add(generation);
      }
    }

    const switchedAt = this.#now().toISOString();
    this.#switchSummary = {
      targetGeneration: this.#targetGeneration!,
      previousAliases,
      aliases,
      switchedAt,
    };
    this.#state = "switched";
    return this.#switchSummary;
  }

  async #readAliasesBestEffort(): Promise<AliasSnapshot | undefined> {
    try {
      return await this.getAliases();
    } catch {
      return undefined;
    }
  }

  async #verifyTarget(): Promise<void> {
    if (this.#options.backend.verifyReadback !== undefined) {
      const outcome = await this.#options.backend.verifyReadback(
        this.#targetGeneration!,
        {
          targetGeneration: this.#targetGeneration!,
          aliases: {
            read: this.#targetGeneration!,
            write: this.#targetGeneration!,
          },
        },
      );

      const observedGeneration =
        typeof outcome === "object" &&
        outcome !== null &&
        "observedGeneration" in outcome &&
        typeof outcome.observedGeneration === "string"
          ? outcome.observedGeneration
          : undefined;

      if (
        !verificationOk(outcome) ||
        (observedGeneration !== undefined &&
          observedGeneration !== this.#targetGeneration)
      ) {
        const detail =
          typeof outcome === "object" &&
          outcome !== null &&
          "detail" in outcome &&
          typeof outcome.detail === "string"
            ? `: ${outcome.detail}`
            : "";
        throw new AliasVerificationError(
          `Read-back verification failed for generation "${this.#targetGeneration}"${detail}`,
        );
      }
    }

    const readback = await this.getAliases();
    if (!isTargetAlias(readback, this.#targetGeneration!)) {
      throw new AliasVerificationError(
        `Alias read-back returned read=${String(readback.read)} write=${String(readback.write)}, expected both to be "${this.#targetGeneration}"`,
      );
    }
    this.#aliases = readback;
  }

  async cleanupRetiredGenerations(
    at: Date = this.#now(),
  ): Promise<CleanupResult> {
    if (this.#switchSummary === undefined) {
      throw new InvalidCoordinatorStateError(
        "cleanupRetiredGenerations() requires a verified alias switch",
      );
    }

    const currentAliases = await this.getAliases();
    const deletedGenerations: string[] = [];
    const retainedGenerations: RetainedGeneration[] = [];

    for (const generation of this.#retiredGenerations) {
      if (generation === this.#targetGeneration) {
        continue;
      }
      if (
        currentAliases.read === generation ||
        currentAliases.write === generation
      ) {
        retainedGenerations.push({
          generation,
          reason: "still-aliased",
        });
        continue;
      }

      const activeLeases = await this.#activeLeases(generation, at);
      if (activeLeases === undefined) {
        retainedGenerations.push({
          generation,
          reason: "lease-registry-unavailable",
        });
        continue;
      }
      if (activeLeases.length > 0) {
        retainedGenerations.push({
          generation,
          reason: "active-reader-leases",
          activeLeaseCount: activeLeases.length,
        });
        continue;
      }

      await this.#options.backend.deleteGeneration(generation, {
        targetGeneration: this.#targetGeneration!,
        reason: "retired-after-alias-switch",
      });
      this.#retiredGenerations.delete(generation);
      deletedGenerations.push(generation);
    }

    return { deletedGenerations, retainedGenerations };
  }

  async #activeLeases(
    generation: string,
    at: Date,
  ): Promise<readonly ReaderLease[] | undefined> {
    const registry = this.#options.readerLeases;
    if (registry === undefined) {
      return undefined;
    }

    const read =
      registry.getActiveLeases?.bind(registry) ??
      registry.listActiveLeases?.bind(registry);
    if (read === undefined) {
      return undefined;
    }

    const leases = await read(generation, at);
    return leases.filter((lease) => leaseIsActive(lease, at));
  }

  #result(cleanup: CleanupResult): CoordinationResult {
    if (
      this.#backfill === undefined ||
      this.#switchSummary === undefined ||
      this.#caughtUpThrough === undefined
    ) {
      throw new InvalidCoordinatorStateError(
        "The migration has not completed successfully",
      );
    }

    return {
      ...this.#switchSummary,
      backfill: this.#backfill,
      caughtUpThrough: this.#caughtUpThrough,
      appliedChanges: this.#appliedChanges,
      retiredGenerations: [...this.#retiredGenerations],
      cleanup,
    };
  }
}

export function createIndexGenerationCoordinator(
  options: IndexGenerationCoordinatorOptions,
): IndexGenerationCoordinator {
  return new IndexGenerationCoordinator(options);
}

export function coordinateIndexGeneration(
  options: IndexGenerationCoordinatorOptions,
): Promise<CoordinationResult> {
  return new IndexGenerationCoordinator(options).run();
}
