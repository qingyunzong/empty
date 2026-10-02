'use strict';

const { BusinessError } = require('./errors');

// 账户三个资金池：
//   budget  预算     —— 预约(reserve)只占用预算
//   credit  可用额度 —— 冻结(freeze)扣减可用额度
//   balance 余额     —— 实付(pay)扣减余额
// 状态同时维护事务登记簿 txs，用于撤销链校验。

function emptyState() {
  return { accounts: {}, txs: {} };
}

function requireAccount(state, name) {
  const acct = state.accounts[name];
  if (!acct) throw new BusinessError(`unknown account: ${name}`);
  return acct;
}

function requireAmount(n) {
  if (!Number.isInteger(n) || n <= 0) throw new BusinessError(`invalid amount: ${n}`);
  return n;
}

function requireNewTx(state, id) {
  if (typeof id !== 'string' || id.length === 0) throw new BusinessError('tx id required');
  if (state.txs[id]) throw new BusinessError(`duplicate tx id: ${id}`);
}

function requireParent(state, parentId, kind, account) {
  const parent = state.txs[parentId];
  if (!parent) throw new BusinessError(`parent tx not found: ${parentId}`);
  if (parent.kind !== kind) throw new BusinessError(`parent tx ${parentId} is not a ${kind}`);
  if (parent.reverted) throw new BusinessError(`parent tx ${parentId} already reverted`);
  if (parent.account !== account) throw new BusinessError(`parent tx ${parentId} belongs to another account`);
  return parent;
}

function hasActiveChild(state, parentId, kind) {
  return Object.values(state.txs).some(
    (t) => t.parent === parentId && t.kind === kind && !t.reverted,
  );
}

function applyTx(state, tx, ctx) {
  switch (tx.kind) {
    case 'reserve': {
      requireNewTx(state, tx.id);
      const acct = requireAccount(state, tx.account);
      const amount = requireAmount(tx.amount);
      if (acct.budget < amount) {
        throw new BusinessError(`insufficient budget on ${tx.account}: need ${amount}, have ${acct.budget}`);
      }
      acct.budget -= amount;
      state.txs[tx.id] = {
        kind: 'reserve', account: tx.account, amount, parent: null,
        layer: ctx.layer, reverted: false,
      };
      return;
    }
    case 'freeze': {
      requireNewTx(state, tx.id);
      const acct = requireAccount(state, tx.account);
      const amount = requireAmount(tx.amount);
      if (tx.parent != null) requireParent(state, tx.parent, 'reserve', tx.account);
      if (acct.credit < amount) {
        throw new BusinessError(`insufficient credit on ${tx.account}: need ${amount}, have ${acct.credit}`);
      }
      acct.credit -= amount;
      state.txs[tx.id] = {
        kind: 'freeze', account: tx.account, amount, parent: tx.parent ?? null,
        layer: ctx.layer, reverted: false, consumed: false,
      };
      return;
    }
    case 'pay': {
      requireNewTx(state, tx.id);
      const acct = requireAccount(state, tx.account);
      const amount = requireAmount(tx.amount);
      let parent = null;
      if (tx.parent != null) {
        parent = requireParent(state, tx.parent, 'freeze', tx.account);
        if (parent.consumed) throw new BusinessError(`freeze ${tx.parent} already consumed by a pay`);
      }
      if (acct.balance < amount) {
        throw new BusinessError(`insufficient balance on ${tx.account}: need ${amount}, have ${acct.balance}`);
      }
      acct.balance -= amount;
      if (parent) parent.consumed = true;
      state.txs[tx.id] = {
        kind: 'pay', account: tx.account, amount, parent: tx.parent ?? null,
        layer: ctx.layer, reverted: false,
      };
      return;
    }
    case 'revert': {
      requireNewTx(state, tx.id);
      const target = state.txs[tx.target];
      if (!target) throw new BusinessError(`revert target not found: ${tx.target}`);
      if (target.reverted) throw new BusinessError(`tx already reverted: ${tx.target}`);
      // 只能回退到检查点之后的层级
      if (target.layer <= ctx.latestCheckpointLayer) {
        throw new BusinessError(
          `cannot revert tx ${tx.target} from layer ${target.layer}: ` +
          `at or before checkpoint layer ${ctx.latestCheckpointLayer}`,
        );
      }
      const acct = requireAccount(state, target.account);
      if (target.kind === 'pay') {
        // 撤销实付：余额回补，并先恢复对应冻结链路（金额回到冻结态，而非直接释放额度）
        if (target.parent) {
          const freeze = state.txs[target.parent];
          if (!freeze || freeze.reverted) {
            throw new BusinessError(`freeze chain of pay ${tx.target} is broken; restore it first`);
          }
          freeze.consumed = false;
        }
        acct.balance += target.amount;
        target.reverted = true;
      } else if (target.kind === 'freeze') {
        if (target.consumed) {
          throw new BusinessError(`freeze ${tx.target} consumed by a pay; revert the pay first`);
        }
        if (hasActiveChild(state, tx.target, 'pay')) {
          throw new BusinessError(`active pay depends on freeze ${tx.target}; revert the pay first`);
        }
        acct.credit += target.amount;
        target.reverted = true;
      } else if (target.kind === 'reserve') {
        if (hasActiveChild(state, tx.target, 'freeze')) {
          throw new BusinessError(`active freeze depends on reserve ${tx.target}; revert the freeze chain first`);
        }
        acct.budget += target.amount;
        target.reverted = true;
      } else {
        throw new BusinessError(`cannot revert tx of kind: ${target.kind}`);
      }
      state.txs[tx.id] = {
        kind: 'revert', account: target.account, amount: target.amount, parent: null,
        target: tx.target, layer: ctx.layer, reverted: false,
      };
      return;
    }
    default:
      throw new BusinessError(`unknown tx kind: ${tx.kind}`);
  }
}

// 整层应用：任一事务失败即抛错，调用方保证不提交（state 为调用方持有的副本）。
function applyLayer(state, txs, ctx) {
  if (!Array.isArray(txs)) throw new BusinessError('layer payload must contain a tx array');
  for (const tx of txs) applyTx(state, tx, ctx);
  return state;
}

module.exports = { emptyState, applyTx, applyLayer };
