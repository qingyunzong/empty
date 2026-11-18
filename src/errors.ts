export type HandshakeErrorCode =
  | "ILLEGAL_TRANSITION"
  | "INVALID_MESSAGE"
  | "INVALID_STATE"
  | "SECRET_UNAVAILABLE"
  | "DERIVATION_ORDER"
  | "CERTIFICATE_REJECTED"
  | "CERTIFICATE_SIGNATURE_REJECTED"
  | "FINISHED_REJECTED"
  | "EARLY_DATA_REJECTED"
  | "EARLY_DATA_REPLAY"
  | "LATE_CONFIRMATION";

export class HandshakeError extends Error {
  readonly code: HandshakeErrorCode;
  readonly state: string | undefined;

  constructor(code: HandshakeErrorCode, message: string, state?: string) {
    super(message);
    this.name = "HandshakeError";
    this.code = code;
    this.state = state;
  }
}

export class IllegalTransitionError extends HandshakeError {
  readonly event: string;

  constructor(state: string, event: string) {
    super("ILLEGAL_TRANSITION", `illegal transition from ${state} on ${event}`, state);
    this.name = "IllegalTransitionError";
    this.event = event;
  }
}

export class InvalidMessageError extends HandshakeError {
  constructor(message: string, state?: string) {
    super("INVALID_MESSAGE", message, state);
    this.name = "InvalidMessageError";
  }
}

export class SecretUnavailableError extends HandshakeError {
  readonly secret: string;

  constructor(secret: string) {
    super("SECRET_UNAVAILABLE", `secret ${secret} is not available in the current key phase`);
    this.name = "SecretUnavailableError";
    this.secret = secret;
  }
}

export class DerivationOrderError extends HandshakeError {
  constructor(message: string) {
    super("DERIVATION_ORDER", message);
    this.name = "DerivationOrderError";
  }
}

export class CertificateVerificationError extends HandshakeError {
  constructor(message: string, state?: string) {
    super("CERTIFICATE_REJECTED", message, state);
    this.name = "CertificateVerificationError";
  }
}

export class EarlyDataRejectedError extends HandshakeError {
  readonly reason: string;

  constructor(reason: string, code: "EARLY_DATA_REJECTED" | "EARLY_DATA_REPLAY" = "EARLY_DATA_REJECTED") {
    super(code, `0-RTT early data rejected: ${reason}`);
    this.name = "EarlyDataRejectedError";
    this.reason = reason;
  }
}

export class EarlyDataReplayError extends EarlyDataRejectedError {
  constructor() {
    super("replay", "EARLY_DATA_REPLAY");
    this.name = "EarlyDataReplayError";
  }
}
