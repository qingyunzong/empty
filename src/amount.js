export function parseAmount(str) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(str).trim());
  if (!m) throw new Error(`invalid amount: ${JSON.stringify(str)}`);
  const sign = m[1] === '-' ? -1 : 1;
  const frac = m[3] ? Number(m[3].padEnd(2, '0')) : 0;
  return sign * (Number(m[2]) * 100 + frac);
}

export function formatAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
