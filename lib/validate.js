'use strict';

function validateInstruction(inst) {
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) {
    throw new Error('指令必须是对象');
  }
  if (inst.id === undefined || inst.id === null || inst.id === '') {
    throw new Error('指令缺少 id');
  }
  if (inst.side !== 'buy' && inst.side !== 'sell') {
    throw new Error(`指令 ${inst.id} 为单边/非法方向指令: side=${JSON.stringify(inst.side)}`);
  }
  if (typeof inst.security !== 'string' || inst.security.length === 0) {
    throw new Error(`指令 ${inst.id} 缺少证券代码 security`);
  }
  if (typeof inst.price !== 'number' || !Number.isFinite(inst.price) || inst.price <= 0) {
    throw new Error(`指令 ${inst.id} 价格非法: ${JSON.stringify(inst.price)}`);
  }
  if (typeof inst.quantity !== 'number' || !Number.isInteger(inst.quantity) || inst.quantity <= 0) {
    throw new Error(`指令 ${inst.id} 数量非法: ${JSON.stringify(inst.quantity)}`);
  }
}

function validateAccount(acc) {
  if (!acc || typeof acc !== 'object' || Array.isArray(acc)) {
    throw new Error('账户必须是对象');
  }
  if (acc.id === undefined || acc.id === null || acc.id === '') {
    throw new Error('账户缺少 id');
  }
  if (acc.cash !== undefined && (typeof acc.cash !== 'number' || acc.cash < 0)) {
    throw new Error(`账户 ${acc.id} 现金非法: ${JSON.stringify(acc.cash)}`);
  }
  if (acc.securities !== undefined) {
    if (typeof acc.securities !== 'object' || acc.securities === null || Array.isArray(acc.securities)) {
      throw new Error(`账户 ${acc.id} 证券持仓非法`);
    }
    for (const [sec, qty] of Object.entries(acc.securities)) {
      if (typeof qty !== 'number' || qty < 0) {
        throw new Error(`账户 ${acc.id} 证券 ${sec} 数量非法: ${JSON.stringify(qty)}`);
      }
    }
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('输入必须是 JSON 对象');
  }
  if (!Array.isArray(input.accounts)) {
    throw new Error('缺少 accounts 数组');
  }
  const accountIds = new Set();
  for (const acc of input.accounts) {
    validateAccount(acc);
    if (accountIds.has(acc.id)) throw new Error(`账户 id 重复: ${acc.id}`);
    accountIds.add(acc.id);
  }
  if (!Array.isArray(input.instructions)) {
    throw new Error('缺少 instructions 数组');
  }
  const instructionIds = new Set();
  for (const inst of input.instructions) {
    validateInstruction(inst);
    if (instructionIds.has(inst.id)) throw new Error(`指令 id 重复: ${inst.id}`);
    instructionIds.add(inst.id);
  }
  const permissions = input.permissions ?? {};
  const permEntries = Array.isArray(permissions)
    ? permissions.map((p) => [p && p.instruction, p && p.accounts])
    : Object.entries(permissions);
  for (const [instId, accounts] of permEntries) {
    if (!Array.isArray(accounts)) {
      throw new Error(`指令 ${instId} 的配对许可必须是账户数组`);
    }
    for (const accId of accounts) {
      if (!accountIds.has(accId)) throw new Error(`配对许可引用了不存在的账户: ${accId}`);
    }
  }
  if (input.cancellations !== undefined && !Array.isArray(input.cancellations)) {
    throw new Error('cancellations 必须是指令 id 数组');
  }
}

module.exports = { validateInstruction, validateAccount, validateInput };
