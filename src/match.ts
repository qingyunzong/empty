import { Seg } from "./pattern";

/**
 * Direct glob matcher used as the ground-truth oracle for cross-checking.
 * '*' matches exactly one segment, '**' matches zero or more segments.
 */
export function matchSegments(segs: Seg[], path: string[]): boolean {
  const n = segs.length;
  const m = path.length;
  const dp: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false)
  );
  dp[0]![0] = true;
  for (let i = 1; i <= n; i++) {
    if (segs[i - 1]!.kind === "starstar") dp[i]![0] = dp[i - 1]![0]!;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = segs[i - 1]!;
      if (s.kind === "lit") {
        dp[i]![j] = dp[i - 1]![j - 1]! && s.value === path[j - 1]!;
      } else if (s.kind === "star") {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = dp[i - 1]![j]! || dp[i]![j - 1]!;
      }
    }
  }
  return dp[n]![m]!;
}
