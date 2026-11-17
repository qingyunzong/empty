# 服务运行时三级隔离组件

可嵌入的 TypeScript 隔离组件：按实例、可用区（AZ）和服务三级汇总失败，区分共同上游故障与局部异常；上层降级时收紧下层探测配额以避免探测风暴；恢复按层逐步放量。

## 设计

- **三级聚合**：`reportFailure` 将失败沿 实例 → 可用区 → 服务 逐级记入滑动窗口，每层独立达到阈值后触发评估。
- **相关性判定**：父层统计窗口内主导错误签名（如 `timeout:upstream:db`）的子节点贡献占比，≥ `correlationThreshold` 且贡献者 ≥ 2 时判定为共同上游故障，隔离提升到父层（`cause: 'upstream'`），已隔离的子节点被释放；否则仅在实例级隔离（`cause: 'local'`）。
- **探测配额**：`tryAcquireProbe` 沿层级链消耗实例/可用区/服务三级配额；任一层非健康时其配额按 `parentThrottleFactor`（恢复中按当前流量权重取较大者）收缩，从而级联收紧整个子树，杜绝上层降级引发的探测风暴。
- **分层放量**：隔离节点经过 `recoveryDelayMs` 冷却进入恢复态，按 `recoveryStages`（默认 10% → 50% → 100%）逐级放量；每级需连续 `recoverySuccessThreshold` 次探测成功，且下层阶段权重不得超过上层当前权重。恢复期间出现失败立即回退到隔离冷却。

## 用法

```ts
import { IsolationController } from './index.js';

const iso = new IsolationController();
const target = { service: 'orders', zone: 'az-1', instance: 'pod-7' };

iso.reportFailure(target, 'timeout:upstream:db');
iso.trafficWeight(target);   // 0..1，供负载均衡加权
iso.isolationScope(target);  // 'instance' | 'zone' | 'service' | null
if (iso.tryAcquireProbe(target)) {
  // 执行探测，然后 reportSuccess / reportFailure
}
```

## 验证

`npm test` 先用 `tsc` 编译再运行 `node:test` 测试，覆盖：

- 非相关故障序列 → 仅隔离故障实例；
- 可用区内相关故障 → 提升为可用区级上游隔离并释放被遮蔽实例；
- 跨可用区相关故障 → 提升为服务级上游隔离；
- 混合签名 → 保持实例级隔离不扩散；
- 上层降级/冷却 → 下层探测配额被钳制（健康 20 → 冷却 0 → 恢复 4）；
- 恢复按层逐步放量，下层不得超过上层，恢复期失败回退冷却。
