export class FingerprintMismatchError extends Error {
  constructor(intentId: string, existing: string, given: string) {
    super(
      `意图 ${intentId} 已存在且前置指纹不一致：已记录 ${JSON.stringify(
        existing,
      )}，本次提交 ${JSON.stringify(given)}`,
    );
    this.name = "FingerprintMismatchError";
  }
}

export class StoragePersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super("持久日志写入失败，无法保证意图状态可恢复，调用方必须重试提交");
    this.name = "StoragePersistenceError";
  }
}
