// Seeded random rule/event generator for property-based cross-checking.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = ['alipay', 'wechat', 'unionpay'];
const MERCHANTS = ['MCH100001', 'MCH100002', 'MCH200003', 'VIP00001', 'VIP00002', 'GUEST1'];
const CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '1.2.3.0/24'];
const REGEXES = ['/^MCH[0-9]{6}$/', '/^VIP/'];
const IPS = ['10.1.2.3', '10.200.0.1', '172.16.5.5', '172.31.9.9', '192.168.0.7', '1.2.3.4', '1.2.3.250', '8.8.8.8'];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function moneyStr(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function genCond(rng, depth) {
  const choices = ['amountCmp', 'countCmp', 'amountRange', 'countRange', 'ipIn', 'merchantRe', 'channelEq'];
  if (depth > 0) choices.push('and', 'or', 'not');
  const c = pick(rng, choices);
  switch (c) {
    case 'amountCmp': {
      const op = pick(rng, ['>', '>=', '<', '<=']);
      const rhs = rng() < 0.4 ? 'max_amount' : moneyStr(int(rng, 0, 2000000));
      return `event.amount ${op} ${rhs}`;
    }
    case 'countCmp': {
      const op = pick(rng, ['>', '>=', '<', '<=']);
      const rhs = rng() < 0.4 ? 'max_count' : String(int(rng, 0, 250));
      return `event.count ${op} ${rhs}`;
    }
    case 'amountRange': {
      const lo = int(rng, 0, 1000000);
      const hi = lo + int(rng, 0, 1000000);
      return `event.amount in ${moneyStr(lo)}..${moneyStr(hi)}`;
    }
    case 'countRange': {
      const lo = int(rng, 0, 120);
      const hi = lo + int(rng, 0, 120);
      return `event.count in ${lo}..${hi}`;
    }
    case 'ipIn':
      return `event.ip in ${pick(rng, CIDRS)}`;
    case 'merchantRe':
      return rng() < 0.5 ? `event.merchant in ${pick(rng, REGEXES)}` : 'event.merchant in vip';
    case 'channelEq':
      return `event.channel == "${pick(rng, CHANNELS)}"`;
    case 'and':
      return `(${genCond(rng, depth - 1)}) and (${genCond(rng, depth - 1)})`;
    case 'or':
      return `(${genCond(rng, depth - 1)}) or (${genCond(rng, depth - 1)})`;
    case 'not':
      return `not (${genCond(rng, depth - 1)})`;
    default:
      throw new Error(c);
  }
}

function genRules(rng, prefix, count, indent) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (let i = 0; i < count; i++) {
    const decision = pick(rng, ['allow', 'review', 'deny']);
    out += `${pad}rule ${prefix}_r${i} {\n`;
    out += `${pad}  when ${genCond(rng, 2)} then ${decision}\n`;
    out += `${pad}}\n`;
  }
  return out;
}

export function generateSource(rng) {
  const globalAmount = int(rng, 500000, 2000000);
  const globalCount = int(rng, 50, 200);
  let src = 'version "v1" since "2024-01-01T00:00:00Z" {\n';
  src += '  scope global {\n';
  src += `    threshold max_amount: money = ${moneyStr(globalAmount)};\n`;
  src += `    threshold max_count: count = ${globalCount};\n`;
  src += '    whitelist vip = /^VIP[0-9]{5}$/;\n';
  src += genRules(rng, 'g', int(rng, 1, 3), 2);
  const nChannels = int(rng, 0, 2);
  const chans = [...CHANNELS].sort(() => rng() - 0.5).slice(0, nChannels);
  for (const ch of chans) {
    const chAmount = Math.max(1, Math.floor(globalAmount * (0.3 + rng() * 0.5)));
    src += `    scope channel("${ch}") {\n`;
    src += `      override threshold max_amount: money = ${moneyStr(chAmount)};\n`;
    src += genRules(rng, `c_${ch}`, int(rng, 1, 3), 3);
    if (rng() < 0.6) {
      const mch = pick(rng, MERCHANTS);
      const mAmount = Math.max(1, Math.floor(chAmount * (0.3 + rng() * 0.5)));
      src += `      scope merchant("${mch}") {\n`;
      src += `        override threshold max_amount: money = ${moneyStr(mAmount)};\n`;
      src += genRules(rng, `m_${ch}`, int(rng, 1, 2), 4);
      src += '      }\n';
    }
    src += '    }\n';
  }
  src += '  }\n';
  src += '}\n';
  return src;
}

export function generateEvent(rng, idx) {
  return {
    id: `ev${idx}`,
    time: `2024-0${int(rng, 2, 5)}-1${int(rng, 0, 9)}T0${int(rng, 0, 9)}:00:00Z`,
    merchant: pick(rng, MERCHANTS),
    channel: pick(rng, [...CHANNELS, 'unknownch']),
    ip: pick(rng, IPS),
    amount: int(rng, 0, 2500000) / 100,
    count: int(rng, 0, 260),
  };
}
