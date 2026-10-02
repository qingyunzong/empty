'use strict';

// 业务错误：余额不足、撤销规则冲突、参数缺失等。退出码 1。
class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
    this.exitCode = 1;
  }
}

// 数据损坏：CRC 不符、哈希链断裂、截断等。退出码 2。
class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError';
    this.exitCode = 2;
    this.torn = false;
    this.offset = -1;
  }
}

// 索引损坏：索引指向的偏移处层号或哈希不符。退出码 2。
class IndexCorruptionError extends CorruptionError {
  constructor(message) {
    super(message);
    this.name = 'IndexCorruptionError';
  }
}

// 测试用：模拟写块后、链接前崩溃。
class CrashSimulatedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrashSimulatedError';
  }
}

module.exports = { BusinessError, CorruptionError, IndexCorruptionError, CrashSimulatedError };
