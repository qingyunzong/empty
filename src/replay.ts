import { apply } from './apply.js';
import { stateCertificate } from './certificate.js';
import type { Event } from './events.js';
import type { State } from './state.js';
import { initialState } from './state.js';

/** 从头重放：空状态起逐条应用事件，并强制校验显式顺序（seq 必须从 1 连续递增） */
export function replay(events: readonly Event[]): State {
  const state = initialState();
  events.forEach((event, index) => {
    if (event.seq !== index + 1) {
      throw new Error(`event order violated: position ${index + 1} carries seq ${event.seq}`);
    }
    apply(state, event);
  });
  return state;
}

export function replayCertificate(events: readonly Event[]): string {
  return stateCertificate(replay(events), events.length);
}

/** 与线上执行产出的状态证书对照 */
export function verifyAgainstReplay(events: readonly Event[], liveCertificate: string): boolean {
  return replayCertificate(events) === liveCertificate;
}
