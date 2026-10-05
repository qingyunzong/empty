export type PermissionFailureKind = "revoked" | "epoch-changed";

/**
 * Thrown when the pre-publish re-verification finds a row whose permission
 * was revoked or whose permission epoch changed since the snapshot was taken.
 * The whole file is withheld from publishing.
 */
export class PermissionVerificationError extends Error {
  readonly rowId: string;
  readonly kind: PermissionFailureKind;
  readonly snapshotEpoch: number;
  readonly currentEpoch: number | null;

  constructor(
    rowId: string,
    kind: PermissionFailureKind,
    snapshotEpoch: number,
    currentEpoch: number | null
  ) {
    super(
      kind === "revoked"
        ? `permission revoked for row "${rowId}" (snapshot epoch ${snapshotEpoch}); export withheld`
        : `permission epoch changed for row "${rowId}": snapshot ${snapshotEpoch} -> current ${currentEpoch}; export withheld`
    );
    this.name = "PermissionVerificationError";
    this.rowId = rowId;
    this.kind = kind;
    this.snapshotEpoch = snapshotEpoch;
    this.currentEpoch = currentEpoch;
  }
}
