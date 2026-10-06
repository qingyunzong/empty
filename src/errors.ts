export class QuotaExceededError extends Error {
  constructor(
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`额度不足：申请 ${requested}，可用 ${available}`);
    this.name = "QuotaExceededError";
  }
}

export class PublishRejectedError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly reservedBytes: number,
  ) {
    super(`实际量 ${actualBytes} 超出预留 ${reservedBytes}，拒绝发布`);
    this.name = "PublishRejectedError";
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly state: string,
    public readonly attempted: string,
  ) {
    super(`会话 ${sessionId} 已处于终态 ${state}，不允许 ${attempted}`);
    this.name = "InvalidStateTransitionError";
  }
}

export class StaleGenerationError extends Error {
  constructor(
    public readonly objectId: string,
    public readonly handleGeneration: number,
    public readonly currentGeneration: number,
  ) {
    super(
      `对象 ${objectId} 句柄代际 ${handleGeneration} 已过期，当前代际 ${currentGeneration}`,
    );
    this.name = "StaleGenerationError";
  }
}

export class UnknownSessionError extends Error {
  constructor(public readonly sessionId: string) {
    super(`会话不存在：${sessionId}`);
    this.name = "UnknownSessionError";
  }
}
