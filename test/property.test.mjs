import test from 'node:test';
import { QuicRecovery } from '../build/src/index.js';
import { assertConservation } from './helpers.mjs';

test('deterministic mixed-event trace preserves all invariants', () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  const spaces = ['initial', 'handshake', 'application'];
  const frameSizes = new Map();
  for (let index = 0; index < 12; index += 1) {
    frameSizes.set(`f${index}`, 20 + index * 7);
  }

  const recovery = new QuicRecovery({
    initialRtt: 50,
    granularity: 1,
    maxAckDelay: 10,
    handshakeConfirmed: true,
  });

  let now = 0;
  for (let step = 0; step < 1200; step += 1) {
    now += random() * 5;
    const operation = random();

    if (operation < 0.45) {
      const space = spaces[Math.floor(random() * spaces.length)];
      const frameIds = new Set();
      const count = 1 + Math.floor(random() * 3);
      while (frameIds.size < count) {
        frameIds.add(`f${Math.floor(random() * frameSizes.size)}`);
      }
      recovery.sendPacket({
        space,
        now,
        frames: [...frameIds].map((id) => ({
          id,
          size: frameSizes.get(id),
        })),
        overheadBytes: Math.floor(random() * 8),
      });
    } else if (operation < 0.8) {
      const space = spaces[Math.floor(random() * spaces.length)];
      const snapshot = recovery.getSpaceSnapshot(space);
      if (snapshot.largestSent !== null) {
        const largest = Math.floor(random() * (snapshot.largestSent + 1));
        const smallest = Math.max(0, largest - Math.floor(random() * 4));
        const isolated = Math.floor(
          random() * (snapshot.largestSent + 1),
        );
        recovery.onAckReceived({
          space,
          now,
          ranges: [
            { smallest, largest },
            { smallest: isolated, largest: isolated },
          ],
          ackDelay: Math.floor(random() * 20),
        });
      }
    } else {
      recovery.onTimer(now);
    }

    assertConservation(recovery);
  }
});

