export function tokenize(text) {
  const matches = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}
