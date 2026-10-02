import { parseFile } from './parser.js';
import { compileRuleset } from './compiler.js';
import { evaluateRuleset } from './evaluate.js';
import { E } from './errors.js';

export class RuleStore {
  constructor() { this.versions = []; }

  loadSource(source) {
    for (const ast of parseFile(source)) this.add(compileRuleset(ast));
    return this;
  }

  add(ruleset) {
    if (this.versions.some((v) => v.version === ruleset.version))
      throw E('E_VERSION', `duplicate rules version ${ruleset.version}`);
    const validFrom = ruleset.validFrom ?? 0;
    const maxExisting = this.versions.reduce((m, v) => Math.max(m, v.validFrom), -Infinity);
    if (validFrom <= maxExisting)
      throw E('E_VERSION', `version ${ruleset.version}: valid_from must be later than all loaded versions`);
    this.versions.push({ ...ruleset, validFrom });
    this.versions.sort((a, b) => a.validFrom - b.validFrom);
  }

  versionFor(ts) {
    const t = typeof ts === 'string' ? Date.parse(ts) : ts;
    if (typeof t !== 'number' || Number.isNaN(t))
      throw E('E_VERSION', `bad event timestamp '${ts}'`);
    let best = null;
    for (const v of this.versions)
      if (v.validFrom <= t && (!best || v.validFrom > best.validFrom)) best = v;
    if (!best)
      throw E('E_VERSION', `no rules version covers ${new Date(t).toISOString()}`);
    return best;
  }

  evaluate(event, opts = {}) {
    let v;
    if (opts.version != null) {
      v = this.versions.find((x) => x.version === opts.version);
      if (!v) throw E('E_VERSION', `unknown rules version ${opts.version}`);
    } else {
      v = this.versionFor(event.ts ?? 0);
    }
    return { version: v.version, ...evaluateRuleset(v, event) };
  }
}
