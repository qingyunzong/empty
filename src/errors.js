'use strict';

class ReconError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
    if (details) this.details = details;
  }
}

const ERR_CYCLE = 20;       // 循环依赖
const ERR_ORPHAN = 21;      // 孤儿回单
const ERR_BUDGET = 22;      // 预算越界

module.exports = { ReconError, ERR_CYCLE, ERR_ORPHAN, ERR_BUDGET };
