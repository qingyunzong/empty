export const DEFAULT_PATTERNS = [
  { id: 'boot-then-crit', parts: [{ lit: 'BOOT' }, { any: true }, { lit: 'CRIT' }] },
  { id: 'err-pair', parts: [{ re: '^ERR' }, { re: '^ERR' }] },
  { id: 'temp-spike', parts: [{ lit: 'TEMP' }, { re: 'CRIT|FAULT' }] },
];
