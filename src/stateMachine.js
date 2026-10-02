// Transaction lifecycle:
//   auth -> capture | void
//   capture -> refund | chargeback
//   refund -> capture (reverse_refund, at most once per transaction)
//   chargeback -> capture (reverse_chargeback, only if not settlement-locked)
//   void is terminal and immutable.
export const TRANSITIONS = Object.freeze({
  auth: Object.freeze({ capture: 'capture', void: 'void' }),
  capture: Object.freeze({ refund: 'refund', chargeback: 'chargeback' }),
  refund: Object.freeze({ reverse_refund: 'capture' }),
  chargeback: Object.freeze({ reverse_chargeback: 'capture' }),
  void: Object.freeze({}),
});

export const TERMINAL_STATES = Object.freeze(new Set(['void']));

export const EVENT_TYPES = Object.freeze([
  'auth',
  'capture',
  'void',
  'refund',
  'chargeback',
  'reverse_refund',
  'reverse_chargeback',
  'settle',
]);
