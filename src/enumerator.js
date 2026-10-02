export function applyOpsIndependent(balances, frozenIndices, ops) {
  const accounts = balances.map((balance, index) => ({
    balance,
    held: 0,
    frozen: frozenIndices.includes(index),
  }));
  const reservations = {};
  for (const op of ops) {
    if (op.type === 'reserve') {
      const account = accounts[op.account];
      const duplicate = Object.prototype.hasOwnProperty.call(reservations, op.reservationId);
      if (
        account &&
        !account.frozen &&
        Number.isInteger(op.amount) &&
        op.amount > 0 &&
        op.amount <= account.balance - account.held &&
        !duplicate
      ) {
        account.held += op.amount;
        reservations[op.reservationId] = {
          id: op.reservationId,
          account: op.account,
          amount: op.amount,
          status: 'open',
        };
      }
    } else if (op.type === 'settle') {
      const reservation = reservations[op.reservationId];
      if (reservation && reservation.status === 'open') {
        accounts[reservation.account].held -= reservation.amount;
        accounts[reservation.account].balance -= reservation.amount;
        reservation.status = 'settled';
      }
    } else if (op.type === 'cancel') {
      const reservation = reservations[op.reservationId];
      if (reservation && reservation.status === 'open') {
        accounts[reservation.account].held -= reservation.amount;
        reservation.status = 'cancelled';
      }
    }
  }
  return { accounts, reservations };
}

export function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

export function enumerateFinalStates(balances, frozenIndices, ops) {
  const results = [];
  for (const order of permutations(ops)) {
    results.push({
      order: order.map((op) => op.id),
      state: applyOpsIndependent(balances, frozenIndices, order),
    });
  }
  return results;
}
