// Independent reference state machine used only by the differential tests.
// It re-implements the same spec with a deliberately different code shape
// (pure function, closure state, if/else chains) so implementation bugs in
// src/engine.js surface as mismatches.
const DEFAULT_TTL = 10;

export function runRef(initialBalance, ops) {
  const ordered = [...ops].sort((a, b) => (a.clock - b.clock)
    || (a.clientOpId < b.clientOpId ? -1 : a.clientOpId > b.clientOpId ? 1 : 0));
  const known = new Map(ops.map((o) => [o.clientOpId, o]));

  let available = initialBalance;
  let frozen = 0;
  const totals = { captured: 0, refunded: 0, voided: 0, expired: 0 };
  const auths = new Map();
  const captures = new Map();
  const reversals = new Map();
  const results = new Map();

  const err = (code) => ({ status: 'ERROR', code });

  function reverseAuth(op, auth) {
    if (auth.state === 'EXPIRED' || auth.state === 'FAILED') return err('FROZEN');
    if (auth.state === 'REVERSED') {
      return { status: 'IDEMPOTENT', rootId: auth.id, cumulative: auth.reversed };
    }
    if (auth.state === 'PENDING' && op.clock >= auth.expiresAt) {
      frozen -= auth.remaining;
      available += auth.remaining;
      auth.remaining = 0;
      auth.state = 'FAILED';
      return err('FROZEN');
    }
    if (auth.remaining === 0) {
      return { status: 'IDEMPOTENT', rootId: auth.id, cumulative: auth.reversed };
    }
    const amount = op.amount === undefined ? auth.remaining : op.amount;
    if (amount > auth.remaining) return err('INSUFFICIENT');
    auth.remaining -= amount;
    auth.reversed += amount;
    frozen -= amount;
    available += amount;
    totals.voided += amount;
    if (auth.remaining === 0) auth.state = auth.captured > 0 ? 'CAPTURED' : 'REVERSED';
    reversals.set(op.clientOpId, {
      id: op.clientOpId, rootId: auth.id, rootType: 'authorize', amount, clock: op.clock,
    });
    return { status: 'OK', reversed: amount, rootId: auth.id, cumulative: auth.reversed };
  }

  function reverseCapture(op, cap) {
    const left = cap.amount - cap.reversed;
    if (left === 0) return { status: 'IDEMPOTENT', rootId: cap.id, cumulative: cap.reversed };
    const amount = op.amount === undefined ? left : op.amount;
    if (amount > left) return err('INSUFFICIENT');
    cap.reversed += amount;
    available += amount;
    totals.refunded += amount;
    reversals.set(op.clientOpId, {
      id: op.clientOpId, rootId: cap.id, rootType: 'capture', amount, clock: op.clock,
    });
    return { status: 'OK', reversed: amount, rootId: cap.id, cumulative: cap.reversed };
  }

  for (const op of ordered) {
    let res;
    if (op.type === 'deposit') {
      available += op.amount;
      res = { status: 'OK', deposited: op.amount };
    } else if (op.type === 'authorize') {
      if (op.amount > available) {
        res = err('INSUFFICIENT');
      } else {
        available -= op.amount;
        frozen += op.amount;
        const ttl = op.ttl === undefined ? DEFAULT_TTL : op.ttl;
        auths.set(op.clientOpId, {
          id: op.clientOpId,
          amount: op.amount,
          remaining: op.amount,
          captured: 0,
          reversed: 0,
          state: 'PENDING',
          clock: op.clock,
          expiresAt: op.clock + ttl,
        });
        res = { status: 'OK', authId: op.clientOpId, expiresAt: op.clock + ttl };
      }
    } else if (op.type === 'capture') {
      const auth = auths.get(op.parentId);
      if (!auth) {
        const parent = known.get(op.parentId);
        res = err(parent && parent.clock > op.clock ? 'TIME_TRAVEL' : 'BAD_PARENT');
      } else if (auth.state === 'EXPIRED' || auth.state === 'FAILED') {
        res = err('FROZEN');
      } else if (auth.state === 'PENDING' && op.clock >= auth.expiresAt) {
        frozen -= auth.remaining;
        available += auth.remaining;
        auth.remaining = 0;
        auth.state = 'FAILED';
        res = err('FROZEN');
      } else if (op.amount > auth.remaining) {
        res = err('INSUFFICIENT');
      } else {
        auth.remaining -= op.amount;
        auth.captured += op.amount;
        frozen -= op.amount;
        totals.captured += op.amount;
        if (auth.remaining === 0) auth.state = 'CAPTURED';
        captures.set(op.clientOpId, {
          id: op.clientOpId, authId: auth.id, amount: op.amount, reversed: 0, clock: op.clock,
        });
        res = { status: 'OK', captured: op.amount, authId: auth.id };
      }
    } else if (op.type === 'reverse') {
      let root = auths.get(op.parentId);
      let rootType = 'authorize';
      if (!root) {
        root = captures.get(op.parentId);
        rootType = 'capture';
      }
      if (!root) {
        const prev = reversals.get(op.parentId);
        if (!prev) {
          const parent = known.get(op.parentId);
          res = err(parent && parent.clock > op.clock ? 'TIME_TRAVEL' : 'BAD_PARENT');
        } else {
          root = prev.rootType === 'authorize'
            ? auths.get(prev.rootId)
            : captures.get(prev.rootId);
          res = prev.rootType === 'authorize' ? reverseAuth(op, root) : reverseCapture(op, root);
        }
      } else {
        res = rootType === 'authorize' ? reverseAuth(op, root) : reverseCapture(op, root);
      }
    } else if (op.type === 'expire') {
      const auth = auths.get(op.parentId);
      if (!auth) {
        const parent = known.get(op.parentId);
        res = err(parent && parent.clock > op.clock ? 'TIME_TRAVEL' : 'BAD_PARENT');
      } else if (auth.state !== 'PENDING') {
        res = { status: 'IDEMPOTENT', transition: auth.state };
      } else if (op.clock < auth.expiresAt) {
        res = { status: 'PENDING', expiresAt: auth.expiresAt };
      } else {
        frozen -= auth.remaining;
        available += auth.remaining;
        totals.expired += auth.remaining;
        auth.remaining = 0;
        auth.state = 'EXPIRED';
        res = { status: 'OK', transition: 'EXPIRED' };
      }
    } else {
      throw new Error(`ref model: unexpected op type ${op.type}`);
    }
    results.set(op.clientOpId, res);
  }

  let openAuthorizations = 0;
  let terminalAuthorizations = 0;
  for (const auth of auths.values()) {
    if (auth.state === 'PENDING') openAuthorizations += 1;
    else terminalAuthorizations += 1;
  }

  return {
    view: {
      available,
      frozen,
      captured: totals.captured - totals.refunded,
      refunded: totals.refunded,
      voided: totals.voided,
      expired: totals.expired,
      openAuthorizations,
      terminalAuthorizations,
    },
    results,
  };
}
