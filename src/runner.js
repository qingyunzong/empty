import { Engine } from './engine.js';
import { Protocol } from './protocol.js';
import { Wal } from './wal.js';

export function runFrames(frames, { walPath = null, replay = false, hooks = {} } = {}) {
  const wal = Wal.open(walPath, { replay });
  const engine = new Engine(wal, hooks);
  const protocol = new Protocol();
  const responses = [];
  const deliver = (frame, meta = {}) => {
    const response = engine.process(frame);
    protocol.record(frame.seq, response);
    responses.push({ seq: frame.seq, type: frame.type, ...meta, response });
  };
  for (const frame of frames) {
    for (const item of protocol.push(frame)) {
      if (item.dup) {
        responses.push({ seq: item.seq, type: frame.type, dup: true, response: item.response });
      } else {
        deliver(item.frame);
      }
    }
  }
  for (const item of protocol.flush()) deliver(item.frame, { gap: true });
  return { engine, responses, report: engine.report() };
}

export function exitCode(report) {
  if (report.errors.some((e) => e.type === 'conflict')) return 3;
  if (report.errors.some((e) => e.type === 'over_limit')) return 4;
  return 0;
}
