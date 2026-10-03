export function judgeValue(item, value, ngStreak) {
  if (value >= item.min && value <= item.max) {
    return { judgment: 'OK', ngStreak: 0 };
  }
  const streak = ngStreak + 1;
  return { judgment: streak >= 2 ? 'NCR' : 'NG', ngStreak: streak };
}
