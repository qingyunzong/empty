// 独立参考状态机：与 src/machine.js 刻意分开实现（switch 风格），
// 仅供测试做 n<=9 全序列枚举对照，不参与生产代码路径。
export function refStep(status, cmd) {
  switch (cmd) {
    case 'create':
      if (status !== null) return { ok: false };
      return { ok: true, status: 'created' };
    case 'assign':
      if (status === 'created') return { ok: true, status: 'assigned' };
      return { ok: false };
    case 'start':
      if (status === 'assigned') return { ok: true, status: 'started' };
      return { ok: false };
    case 'complete':
      if (status === 'started') return { ok: true, status: 'completed' };
      return { ok: false };
    case 'cancel':
      if (status === 'created' || status === 'assigned') return { ok: true, status: 'cancelled' };
      return { ok: false };
    default:
      return { ok: false };
  }
}
