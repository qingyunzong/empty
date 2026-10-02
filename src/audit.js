import { Engine, WINDOW_MS, iso } from './engine.js';
import { optimize, bruteForce } from './optimize.js';

const EPS = 1e-9;

export function runAudit(events) {
  const engine = new Engine();
  for (const event of events) engine.apply(event);
  const windows = engine.finalize();

  const baselineCost = windows.reduce((acc, w) => Math.max(acc, w.grossKw * w.rate), 0);
  const optimal = optimize(windows);
  const executedCost = windows.reduce((acc, w) => Math.max(acc, w.netKw * w.rate), 0);
  const executedShedKw = windows.reduce((acc, w) => acc + w.shedKw, 0);

  let peak = null;
  for (const w of windows) {
    if (!peak || w.grossKw > peak.grossKw) {
      peak = { windowStart: w.windowStart, grossKw: w.grossKw };
    }
  }

  let exhaustive;
  if (windows.length === 0) {
    exhaustive = { skipped: true, reason: 'no windows' };
  } else if (windows.length <= 3) {
    const brute = bruteForce(windows);
    if (brute.skipped) {
      exhaustive = brute;
    } else {
      exhaustive = {
        skipped: false,
        windows: windows.length,
        combinations: brute.combinations,
        bruteForce: { cost: brute.cost, totalShedKw: brute.totalShedKw },
        verified: optimal.cost <= brute.cost + EPS && optimal.totalShedKw <= brute.totalShedKw + EPS,
        matches: Math.abs(optimal.cost - brute.cost) <= EPS &&
                 Math.abs(optimal.totalShedKw - brute.totalShedKw) <= EPS,
      };
    }
  } else {
    exhaustive = { skipped: true, reason: `${windows.length} windows > 3` };
  }

  const settlement = {
    windowMinutes: WINDOW_MS / 60000,
    watermark: engine.watermark === null ? null : iso(engine.watermark),
    windowCount: windows.length,
    totalKwh: windows.reduce((acc, w) => acc + w.kwh, 0),
    peak,
    baseline: { demandCost: baselineCost },
    optimal: { demandCost: optimal.cost, totalShedKw: optimal.totalShedKw, plan: optimal.plan },
    executed: { demandCost: executedCost, totalShedKw: executedShedKw },
    corrections: engine.corrections,
    lateEvents: engine.late.length,
    exhaustive,
  };

  const windowsJsonl = windows.map((w) => JSON.stringify({
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    kwh: w.kwh,
    grossKw: w.grossKw,
    rate: w.rate,
    rateMissing: w.rateMissing,
    estimated: w.estimated,
    shed: w.shed,
    shedKw: w.shedKw,
    netKw: w.netKw,
    billed: w.billed,
  })).join('\n');

  return {
    windows,
    settlement,
    comp: engine.comp,
    late: engine.late,
    outputs: {
      'windows.jsonl': windowsJsonl ? `${windowsJsonl}\n` : '',
      'settlement.json': `${JSON.stringify(settlement, null, 2)}\n`,
      'comp.jsonl': engine.comp.map((c) => JSON.stringify(c)).join('\n') +
        (engine.comp.length ? '\n' : ''),
      'late.log': engine.late.map((l) => JSON.stringify(l)).join('\n') +
        (engine.late.length ? '\n' : ''),
    },
  };
}
