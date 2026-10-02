// 线性化核验与确定性重放。
import { evaluate, minimalViolation } from './machine.js';

// 核验一段历史: 按记录顺序检查 cmd/ack 因果与安全联锁。
// 输出 verdict / safeState / 最小违例序列。
export function verify(history) {
  const r = evaluate(history);
  return {
    verdict: r.verdict,
    safeState: r.safeState,
    minimalViolation: r.verdict === 'VIOLATION' ? minimalViolation(history) : null,
    violationReason: r.violationReason,
  };
}

// 恢复后重放: 同一批记录必得同一确定状态(与 seed 无关, 纯函数)。
export function replay(records) {
  return evaluate(records);
}
