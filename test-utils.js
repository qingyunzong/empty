export function createGate() {
  const states = new Map();
  const waiters = new Map();
  return {
    signal(key) {
      states.set(key, true);
      const wake = waiters.get(key);
      if (wake) {
        waiters.delete(key);
        wake();
      }
    },
    async wait(key) {
      if (states.get(key)) return;
      await new Promise((resolve) => waiters.set(key, resolve));
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out (permanent wait?): ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
