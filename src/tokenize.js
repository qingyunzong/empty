export function tokenize(text) {
  return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
