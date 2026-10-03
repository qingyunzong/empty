import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeDb(tables) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniopt-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const catalog = { tables: {} };
  for (const [name, def] of Object.entries(tables)) {
    catalog.tables[name] = {
      rowCount: def.rowCount ?? def.rows.length,
      columns: def.columns,
      indexes: def.indexes ?? [],
    };
    fs.writeFileSync(path.join(dir, 'data', `${name}.json`), JSON.stringify(def.rows));
  }
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return dir;
}

export function scenario1Db() {
  // stats are deliberately "as if" the tables were large; actual data is small
  return makeDb({
    users: {
      rowCount: 1000,
      columns: {
        id: { distinct: 100, selectivity: 0.01 },
        name: { distinct: 1000, selectivity: 0.001 },
        age: { distinct: 80, selectivity: 0.0125 },
      },
      rows: [
        { id: 1, name: 'a', age: 30 },
        { id: 2, name: 'b', age: 40 },
        { id: 3, name: 'c', age: null },
        { id: 4, name: 'd', age: 25 },
        { id: null, name: 'e', age: 50 },
      ],
    },
    orders: {
      rowCount: 1000,
      columns: {
        id: { distinct: 10, selectivity: 0.1 },
        user_id: { distinct: 100, selectivity: 0.01 },
        status: { distinct: 3, selectivity: 0.33 },
        amount: { distinct: 500, selectivity: 0.002 },
      },
      rows: [
        { id: 10, user_id: 1, status: 'paid', amount: 100 },
        { id: 11, user_id: 1, status: 'open', amount: 50 },
        { id: 12, user_id: 2, status: 'paid', amount: 70 },
        { id: 13, user_id: 3, status: 'paid', amount: 30 },
        { id: 14, user_id: null, status: 'open', amount: 20 },
        { id: 15, user_id: 99, status: 'paid', amount: 10 },
      ],
    },
    items: {
      rowCount: 1000,
      columns: {
        id: { distinct: 1000, selectivity: 0.001 },
        order_id: { distinct: 10, selectivity: 0.1 },
        sku: { distinct: 200, selectivity: 0.005 },
      },
      rows: [
        { id: 100, order_id: 10, sku: 'x' },
        { id: 101, order_id: 10, sku: 'y' },
        { id: 102, order_id: 11, sku: 'x' },
        { id: 103, order_id: 12, sku: 'z' },
        { id: 104, order_id: 13, sku: 'x' },
        { id: 105, order_id: null, sku: 'w' },
      ],
    },
  });
}

export const SCENARIO1_QUERY = {
  from: 'users',
  joins: [
    { type: 'inner', table: 'orders', on: { left: 'users.id', right: 'orders.user_id' } },
    { type: 'inner', table: 'items', on: { left: 'orders.id', right: 'items.order_id' } },
  ],
};
