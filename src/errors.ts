export type CoordinationErrorCode =
  | "INVALID_STATE"
  | "BACKFILL_INCOMPLETE"
  | "BACKFILL_CHECKPOINT_MISSING"
  | "CATCH_UP_NOT_CONVERGED"
  | "OPEN_GAPS"
  | "NOT_CAUGHT_UP"
  | "ALIAS_CONFLICT"
  | "ALIAS_SWITCH_UNCERTAIN"
  | "ALIAS_VERIFICATION_FAILED"
  | "SWITCH_ALREADY_ATTEMPTED"
  | "DUAL_WRITE_PRIMARY_FAILED"
  | "GAP_PERSISTENCE_FAILED"
  | "LEASE_REGISTRY_MISSING";

export class IndexCoordinationError extends Error {
  readonly code: CoordinationErrorCode;

  constructor(code: CoordinationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexCoordinationError";
    this.code = code;
  }
}

export class InvalidCoordinatorStateError extends IndexCoordinationError {
  constructor(message: string) {
    super("INVALID_STATE", message);
    this.name = "InvalidCoordinatorStateError";
  }
}

export class BackfillIncompleteError extends IndexCoordinationError {
  constructor(message: string) {
    super("BACKFILL_INCOMPLETE", message);
    this.name = "BackfillIncompleteError";
  }
}

export class OpenGapError extends IndexCoordinationError {
  readonly gapIds: readonly string[];

  constructor(gapIds: readonly string[]) {
    super(
      "OPEN_GAPS",
      `Cannot switch aliases while ${gapIds.length} dual-write gap(s) remain: ${gapIds.join(", ")}`,
    );
    this.name = "OpenGapError";
    this.gapIds = gapIds;
  }
}

export class CatchUpNotConvergedError extends IndexCoordinationError {
  constructor(rounds: number, lastVersion: string) {
    super(
      "CATCH_UP_NOT_CONVERGED",
      `Source high watermark kept advancing for ${rounds} catch-up round(s); last caught-up version was ${lastVersion}`,
    );
    this.name = "CatchUpNotConvergedError";
  }
}

export class AliasConflictError extends IndexCoordinationError {
  constructor(message: string) {
    super("ALIAS_CONFLICT", message);
    this.name = "AliasConflictError";
  }
}

export class AliasSwitchUncertainError extends IndexCoordinationError {
  constructor(message: string, options?: ErrorOptions) {
    super("ALIAS_SWITCH_UNCERTAIN", message, options);
    this.name = "AliasSwitchUncertainError";
  }
}

export class AliasVerificationError extends IndexCoordinationError {
  constructor(message: string) {
    super("ALIAS_VERIFICATION_FAILED", message);
    this.name = "AliasVerificationError";
  }
}

export class SwitchAlreadyAttemptedError extends IndexCoordinationError {
  constructor() {
    super(
      "SWITCH_ALREADY_ATTEMPTED",
      "Alias switching is single-shot; a previous attempt may have changed the aliases",
    );
    this.name = "SwitchAlreadyAttemptedError";
  }
}
