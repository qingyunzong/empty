export function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
