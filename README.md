# ranking-events

事件驱动的排名库（TypeScript + Node.js 内置库，无第三方依赖）。

## 规则

- **积分**：默认胜 3 / 平 1 / 负 0（可通过 `new RankingTable({ scoring })` 配置）。
- **比赛事件**：
  - `recordResult` 录入结果（scheduled → played）；
  - `correctResult` 更正已录入的结果（撤销旧积分、应用新积分）；
  - `cancelMatch` 取消场次（已比赛的场次回滚其积分）。
- **增量重算**：每次事件只重算受影响的名次——积分值涉及变化（旧值或新值）的
  整个同积分组重新排序，其余积分组的成员与组内比赛均未变化，保持原相对顺序。
  事件方法返回本次重算涉及的队伍。
- **完整重算核对**：`fullRecompute()` 从比赛记录重算全部积分与名次；
  `assertConsistent()` 校验增量结果与完整重算一致，不一致则抛错。
- **同分排名（递归）**：
  1. 相互战绩小联赛积分（只统计同分队伍之间的比赛）；
  2. 小联赛净胜分；
  3. 仍未分出的子组按同一规则递归（范围缩小到子组内部比赛）；
     若递归无进展（子组 == 原组），按队伍 ID 字典序升序。

## 用法

```ts
import { RankingTable } from './src/ranking';

const t = new RankingTable();
for (const id of ['A', 'B', 'C']) t.addTeam(id);

t.addResult('m1', 'A', 'B', 2, 1);   // 排程并录入
t.scheduleMatch('m2', 'B', 'C');
t.recordResult('m2', 1, 0);
t.correctResult('m1', 2, 2);         // 更正结果 -> 重算受影响名次
t.cancelMatch('m2');                 // 取消场次 -> 回滚积分并重算

console.log(t.getStandings());       // 增量维护的名次
t.assertConsistent();                // 与完整重算核对
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行
```

测试覆盖：基本积分、相互战绩优先于总净胜分、小联赛净胜分、递归平局
（含无进展时按 ID）、取消/更正后的增量重算、非法操作，以及随机事件序列下
增量名次与完整重算逐步核对的模糊测试。实际结果见 `TEST_RESULTS.md`。
