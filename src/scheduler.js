import { StoreError } from './store.js';

export function orderLoad(order) {
  return order.quantity * order.capability;
}

function compareOrders(a, b) {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// A permutation is feasible iff every order fits within one day of machine
// capacity (orders are atomic; days are packed greedily in sequence). Among
// feasible permutations the winner is the lexicographically smallest sequence
// of (dueDate, id) tuples, i.e. orders sorted by due date then id.
export function planSchedule(orders, capacity) {
  const overloaded = orders.filter((o) => orderLoad(o) > capacity);
  if (overloaded.length > 0) {
    throw new StoreError('E_CAPACITY',
      `orders exceed daily capacity ${capacity}: ${overloaded.map((o) => o.id).join(', ')}`,
      { orders: overloaded.map((o) => o.id) });
  }
  const sorted = orders.slice().sort(compareOrders);
  const days = [];
  let current = { day: 1, orders: [], load: 0 };
  for (const o of sorted) {
    const load = orderLoad(o);
    if (current.orders.length > 0 && current.load + load > capacity) {
      days.push(current);
      current = { day: current.day + 1, orders: [], load: 0 };
    }
    current.orders.push(o.id);
    current.load += load;
  }
  if (current.orders.length > 0) days.push(current);
  return {
    order: sorted.map((o) => o.id),
    days,
    totalLoad: orders.reduce((sum, o) => sum + orderLoad(o), 0),
  };
}
