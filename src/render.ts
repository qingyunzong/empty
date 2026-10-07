import { Engine, GameState, Move } from './engine.js';

/** ASCII board: P piece, E enemy, # obstacle, T/t toggle (unused/used), . empty */
export function renderBoard(engine: Engine, s: GameState): string {
  const lines: string[] = [];
  const header = '   ' + Array.from({ length: engine.w }, (_, x) => x).join(' ');
  lines.push(header);
  for (let y = 0; y < engine.h; y++) {
    let row = `${y} `.padStart(3, ' ');
    for (let x = 0; x < engine.w; x++) {
      const c = engine.cell(x, y);
      let ch = '.';
      if (engine.toggleCell === c) ch = s.toggled ? 't' : 'T';
      if (engine.obstacleAt(s, c)) ch = '#';
      if (engine.enemyAt(s, c)) ch = 'E';
      if (s.pos === c) ch = 'P';
      row += ch + ' ';
    }
    lines.push(row.trimEnd());
  }
  return lines.join('\n');
}

export function describeMove(engine: Engine, m: Move): string {
  const [fx, fy] = engine.xy(m.from);
  const [tx, ty] = engine.xy(m.to);
  if (m.kind === 'jump') {
    const [cx, cy] = engine.xy(m.captured!);
    return `JUMP (${fx},${fy}) -> (${tx},${ty})  captures (${cx},${cy})`;
  }
  const [ox, oy] = engine.xy(m.obstacleTo!);
  return `PUSH (${fx},${fy}) -> (${tx},${ty})  obstacle slides to (${ox},${oy})`;
}
