export class JeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JeError';
    this.code = code;
  }
}

// Thrown by the store crash hook when JE_CRASH_MODE=throw. Simulates an
// abrupt kill at the defined crash point; all store writes are synchronous,
// so the on-disk state is identical to a real kill. Not a JeError on
// purpose: it must propagate like a fatal crash, not be handled.
export class SimulatedCrash extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

export const E = {
  balance: (m) => new JeError('E_BALANCE', m),
  period: (m) => new JeError('E_PERIOD', m),
  crash: (m) => new JeError('E_CRASH', m),
  replay: (m) => new JeError('E_REPLAY', m),
  lex: (m) => new JeError('E_LEX', m),
  parse: (m) => new JeError('E_PARSE', m),
  scope: (m) => new JeError('E_SCOPE', m),
  type: (m) => new JeError('E_TYPE', m),
  compile: (m) => new JeError('E_COMPILE', m),
  runtime: (m) => new JeError('E_RUNTIME', m)
};
