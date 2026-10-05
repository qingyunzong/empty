export class UnknownMemberError extends Error {
  constructor(member, eventId) {
    super(`event ${eventId}: unknown member ${JSON.stringify(member)} (no join event in log)`);
    this.name = 'UnknownMemberError';
    this.code = 'E_UNKNOWN_MEMBER';
    this.exitCode = 4;
    this.member = member;
    this.eventId = eventId;
  }
}

export class DigestMismatchError extends Error {
  constructor(divergence) {
    super('digests do not match');
    this.name = 'DigestMismatchError';
    this.code = 'E_DIGEST_MISMATCH';
    this.exitCode = 5;
    this.divergence = divergence;
  }
}

export class ValidationError extends Error {
  constructor(message, eventId) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'E_VALIDATION';
    this.exitCode = 2;
    this.eventId = eventId;
  }
}

export class ConflictError extends Error {
  constructor(eventId) {
    super(`event id ${JSON.stringify(eventId)} seen with conflicting payloads`);
    this.name = 'ConflictError';
    this.code = 'E_CONFLICT';
    this.exitCode = 2;
    this.eventId = eventId;
  }
}
