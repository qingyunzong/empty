import { parse } from './parser.js';
import { checkProgram } from './checker.js';
import { compileVersion } from './compiler.js';
import { runCode } from './vm.js';
import { parseIp } from './ip.js';
import { parseMoney, parseCount } from './money.js';
import { RiskError } from './errors.js';

export const DECISION_RANK = { allow: 1, review: 2, deny: 3 };

export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RiskError('E_TYPE', 'event must be a JSON object');
  }
  const timeMs = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
  if (Number.isNaN(timeMs)) {
    throw new RiskError('E_VERSION', `event ${JSON.stringify(raw.id ?? '?')} has invalid time ${JSON.stringify(raw.time)}`);
  }
  return {
    id: raw.id ?? '',
    time: raw.time,
    timeMs,
    merchant: String(raw.merchant ?? ''),
    channel: String(raw.channel ?? ''),
    ip: parseIp(String(raw.ip ?? '')),
    amount: toCents(raw.amount),
    count: toCount(raw.count),
  };
}

function toCents(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v === 'string') return parseMoney(v);
  throw new RiskError('E_TYPE', `bad amount ${JSON.stringify(v)}`);
}

function toCount(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') return parseCount(v);
  throw new RiskError('E_TYPE', `bad count ${JSON.stringify(v)}`);
}

function matchersMatch(matchers, event) {
  for (const m of matchers) {
    if (m.kind === 'channel' && event.channel !== m.value) return false;
    if (m.kind === 'merchant' && event.merchant !== m.value) return false;
  }
  return true;
}

function compareHits(a, b) {
  const ka = `${a.path}/${a.rule}`;
  const kb = `${b.path}/${b.rule}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export class Engine {
  constructor() {
    this.versions = [];
  }

  // Parse, check and compile a rule source, then hot-insert its versions.
  loadSource(source) {
    const checked = checkProgram(parse(source));
    const loaded = [];
    for (const v of checked.versions) {
      if (this.versions.some((x) => x.version === v.id)) {
        throw new RiskError('E_VERSION', `duplicate rule version "${v.id}"`);
      }
      const compiled = compileVersion(v);
      compiled.regexObjs = compiled.regexes.map((s) => new RegExp(s));
      this.versions.push(compiled);
      loaded.push(compiled);
    }
    this.versions.sort((a, b) => a.since - b.since || a.version.localeCompare(b.version));
    for (let i = 1; i < this.versions.length; i++) {
      if (this.versions[i].since === this.versions[i - 1].since) {
        throw new RiskError(
          'E_VERSION',
          `versions "${this.versions[i - 1].version}" and "${this.versions[i].version}" share the same effective time`,
        );
      }
    }
    return loaded;
  }

  versionFor(timeMs) {
    let best = null;
    for (const v of this.versions) {
      if (v.since <= timeMs) best = v;
    }
    return best;
  }

  evaluate(rawEvent) {
    const event = normalizeEvent(rawEvent);
    const version = this.versionFor(event.timeMs);
    if (!version) {
      throw new RiskError(
        'E_VERSION',
        `no rule version covers event time ${new Date(event.timeMs).toISOString()}`,
      );
    }
    const hits = [];
    for (const rule of version.rules) {
      if (!matchersMatch(rule.matchers, event)) continue;
      if (runCode(rule.code, version.regexObjs, event)) {
        hits.push({ rule: rule.id, path: rule.path, decision: rule.decision });
      }
    }
    hits.sort(compareHits);
    let decision = 'ALLOW';
    let strictest = [];
    if (hits.length > 0) {
      const top = Math.max(...hits.map((h) => DECISION_RANK[h.decision]));
      strictest = hits.filter((h) => DECISION_RANK[h.decision] === top);
      decision = strictest[0].decision.toUpperCase();
    }
    return {
      id: event.id,
      time: event.time,
      timeMs: event.timeMs,
      version: version.version,
      decision,
      hits,
      strictest,
      overrides: version.overrides,
    };
  }

  explain(rawEvent) {
    return formatExplain(this.evaluate(rawEvent));
  }
}

export function formatExplain(r) {
  const lines = [];
  lines.push(`event=${r.id} time=${new Date(r.timeMs).toISOString()} version=${r.version} decision=${r.decision}`);
  lines.push('strictest:');
  if (r.strictest.length === 0) lines.push('  (none)');
  for (const h of r.strictest) lines.push(`  ${h.decision.toUpperCase()} ${h.path}/${h.rule}`);
  lines.push('hits:');
  if (r.hits.length === 0) lines.push('  (none)');
  for (const h of r.hits) lines.push(`  ${h.decision.toUpperCase()} ${h.path}/${h.rule}`);
  if (r.overrides.length > 0) {
    lines.push('overrides:');
    for (const o of r.overrides) {
      lines.push(`  ${o.scope}: threshold ${o.name} ${o.type} ${o.outer} -> ${o.inner} (tightened)`);
    }
  }
  return lines.join('\n');
}
