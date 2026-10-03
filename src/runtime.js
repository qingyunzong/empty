import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
import { runFee } from './vm.js';
import { err } from './errors.js';

export function compileContract(source) {
  const program = parse(lex(source));
  const checked = check(program);
  const contract = compile(checked);
  contract.source = source;
  return contract;
}

export function fmtMoney(cents) {
  const v = BigInt(cents);
  const sign = v < 0n ? '-' : '';
  const a = v < 0n ? -v : v;
  return `${sign}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

export function parseMoney(raw) {
  if (typeof raw !== 'string') throw err('E_LEX', `money value must be a string like "123.45", got ${JSON.stringify(raw)}`);
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw err('E_LEX', `invalid money literal '${raw}' (max 2 decimal places)`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] === '-' ? -cents : cents;
}

export function parseBps(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw !== 'string') throw err('E_LEX', `bps value must be a string like "120bps", got ${JSON.stringify(raw)}`);
  const m = /^(-?)(\d+)(?:bps)?$/.exec(raw);
  if (!m) throw err('E_LEX', `invalid bps literal '${raw}' (integer basis points only)`);
  const v = BigInt(m[2]);
  return m[1] === '-' ? -v : v;
}

export function parseUnits(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw !== 'string') throw err('E_LEX', `units value must be an integer string, got ${JSON.stringify(raw)}`);
  const m = /^(-?)(\d+)$/.exec(raw);
  if (!m) throw err('E_LEX', `invalid units literal '${raw}' (integer only)`);
  const v = BigInt(m[2]);
  return m[1] === '-' ? -v : v;
}

function parseTyped(type, raw) {
  if (type === 'money') return { t: 'money', v: parseMoney(raw) };
  if (type === 'bps') return { t: 'bps', v: parseBps(raw) };
  if (type === 'units') return { t: 'units', v: parseUnits(raw) };
  throw err('E_ORDER', `cannot parse value for type '${type}'`);
}

export function runOrder(contract, order) {
  if (!order || typeof order !== 'object') throw err('E_ORDER', 'order must be an object');
  const { id, op } = order;
  const className = order.class;
  if (id === undefined || id === null) throw err('E_ORDER', 'order is missing "id"');
  if (!className) throw err('E_ORDER', `order ${id} is missing "class"`);
  if (!op) throw err('E_ORDER', `order ${id} is missing "op"`);

  const cls = contract.classes.get(className);
  if (!cls) throw err('E_ORDER', `order ${id}: unknown share class '${className}'`);
  const fn = cls.fns.get(op);
  if (!fn) throw err('E_ORDER', `order ${id}: class '${className}' has no fee rule for op '${op}'`);

  const rawArgs = order.args ?? {};
  if (typeof rawArgs !== 'object') throw err('E_ORDER', `order ${id}: "args" must be an object`);
  const args = new Map();
  for (const prm of fn.params) {
    if (!(prm.name in rawArgs)) throw err('E_ORDER', `order ${id}: missing argument '${prm.name}'`);
    args.set(prm.name, parseTyped(prm.type, rawArgs[prm.name]));
  }
  for (const name of Object.keys(rawArgs)) {
    if (!fn.params.some((prm) => prm.name === name)) {
      throw err('E_ORDER', `order ${id}: unknown argument '${name}'`);
    }
  }

  for (const [name, a] of args) {
    if ((a.t === 'money' || a.t === 'units') && a.v < 0n) {
      throw err('E_DOMAIN', `order ${id}: negative ${name} is not allowed (${a.v})`);
    }
    if (name === 'shares' && a.v === 0n) {
      throw err('E_DOMAIN', `order ${id}: zero shares are not allowed`);
    }
  }

  const rawParams = order.params ?? {};
  if (typeof rawParams !== 'object') throw err('E_ORDER', `order ${id}: "params" must be an object`);
  const orderParams = new Map();
  for (const [name, raw] of Object.entries(rawParams)) {
    const decl = cls.params.get(name) ?? contract.params.get(name);
    if (!decl) throw err('E_ORDER', `order ${id}: unknown param override '${name}'`);
    orderParams.set(name, parseTyped(decl.t, raw));
  }

  const { value, trace, tiers, allocations } = runFee(contract, className, op, args, orderParams);
  return {
    id,
    class: className,
    op,
    fee: fmtMoney(value.v),
    feeCents: String(value.v),
    allocations,
    tiers,
    trace,
  };
}

export function runOrders(contract, ordersRaw) {
  const list = Array.isArray(ordersRaw) ? ordersRaw : ordersRaw.orders;
  if (!Array.isArray(list)) throw err('E_ORDER', 'orders JSON must be an array or an object with an "orders" array');
  const results = list.map((order) => {
    try {
      return runOrder(contract, order);
    } catch (e) {
      if (e && e.code) return { id: order?.id ?? null, error: { code: e.code, message: e.message } };
      throw e;
    }
  });
  return { results };
}
