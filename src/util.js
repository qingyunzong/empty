export function* combinations(items, k) {
  const n = items.length
  if (k < 0 || k > n) return
  const idx = Array.from({ length: k }, (_, i) => i)
  while (true) {
    yield idx.map((i) => items[i])
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) return
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
}
