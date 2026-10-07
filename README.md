# jump-capture-solver

自定义跳吃棋盘谜题的命令行求解器（TypeScript，零依赖）。规则完全自定义，
不借用任何现实棋类。求解器对完整状态空间做带记忆化的穷举搜索，输出
最优捕获证书（certificate）与安全上界，并可用全状态 BFS / 无记忆化
枚举对短棋盘做交叉核验。

## 规则（自定义）

- 棋盘上有一个棋子 `P`、至多 **12** 个敌子 `E`、至多 **6** 块可推障碍 `#`，
  以及至多一个**一次性开关格** `T`。
- **跳吃（JUMP）**：沿当前方向集合中的某方向，相邻格有敌子且正后方格在界内
  且为空（无敌子、无障碍），棋子落到该空格并删除被跳过的敌子。可连跳
  （连跳就是连续多次单跳）。
- **推箱（PUSH）**：沿当前方向集合中的某方向，相邻格有障碍且正后方格在界内
  且为空，棋子走入障碍格、障碍滑动一格。推箱不捕获。
- **开关格（TOGGLE）**：棋子首次**落**在开关格上（跳吃落点或推箱走入均可）
  时，方向集合永久切换为 `altDirections`。切换会影响先前可跳的位置
  （可能变得不可跳，也可能解锁新跳法）。开关只触发一次。
- 棋子没有普通步进，只能跳吃或推箱；无合法着法时序列结束。

## 目标与次序

1. 捕获数最大；
2. 并列时**落点序列**（仅跳吃落点，按 `y*width+x` 格序号）字典序最小；
3. 再并列时总着数最少（该条同时保证搜索有限：任何环都不含捕获，
   去掉环在第 3 条上严格更优，因此 DFS 跳过路径上已出现的状态是安全的）。

## 输入格式（JSON）

```json
{
  "width": 5, "height": 4,
  "start": [0, 1],
  "enemies": [[1, 1], [3, 1], [2, 2]],
  "obstacles": [[3, 2], [3, 0]],
  "toggle": [2, 1],
  "directions": [[1, 0], [-1, 0], [0, 1], [0, -1]],
  "altDirections": [[1, 0], [-1, 0], [0, 1], [0, -1],
                    [1, 1], [1, -1], [-1, 1], [-1, -1]]
}
```

- 坐标为 `[x, y]`，原点左上角；`enemies ≤ 12`、`obstacles ≤ 6`、棋盘 ≤ 64 格。
- `toggle` 与 `altDirections` 必须同时出现或同时省略。
- 校验：`npm run solve -- check <file>` 或 `node dist/src/cli.js check <file>`。

## 使用

```bash
npm run build                 # tsc 编译到 dist/
npm test                      # 编译并运行全部测试（node --test）

node dist/src/cli.js solve  examples/combined.json            # 逐步打印盘面
node dist/src/cli.js solve  examples/combined.json --cert cert.json
node dist/src/cli.js solve  examples/combined.json --max-pops 100 --checkpoint cp.json
node dist/src/cli.js resume cp.json
node dist/src/cli.js verify examples/combined.json            # 全状态对照
node dist/src/cli.js check  examples/combined.json
```

`solve` 输出：初始盘面、每一步着法与落子后盘面、最优捕获数、安全上界、
落点序列、总着数。`--quiet` 只输出摘要。

## 最优捕获证书与安全上界

`--cert out.json` 生成证书并在写出前自检：

- `optimalCaptures`：穷举证明的最优值；`safeUpperBound`：安全上界。
- 上界规则：敌子 `e` 只有在某个（任一方向集合的）方向 `d` 上 `e-d` 与
  `e+d` 都在界内时才可能被吃，统计可满足该必要条件的敌子数即为上界
  （`≤ 敌子总数`）。
- `moves` / `jumpSequence` / `finalState` / `stepHashes`：完整着法序列、
  落点序列、终局状态与每步状态哈希链，`verifyCertificate` 会重放着法、
  校验每步合法性、终局与哈希链（测试覆盖了篡改检测）。

## 搜索状态的保存与恢复

- `--checkpoint cp.json`：求解过程中定期（`--save-interval`，默认每
  65536 个定态）以及结束/暂停时写入检查点。
- `--max-pops N`：本次调用最多定态 N 个状态后暂停，便于演示断点。
- `resume cp.json`：从检查点恢复（含记忆化表、显式搜索栈、统计信息），
  结果与不中断运行完全一致（有测试保证）。

## 短棋盘全状态对照

`verify` 用两种独立方法与求解器对照：

1. **全状态 BFS**：枚举全部可达状态，最大捕获 = 初始敌子数 − 可达最小
   敌子数；
2. **无记忆化穷举**：对所有无环着法序列做朴素 DFS，完整比对
   （捕获数、落点序列、总着数）。

`test/brute.test.ts` 还用固定种子的随机小棋盘（60 例）自动做三方对照。

## 项目结构

- `src/model.ts` — 输入解析与校验（敌 ≤12、障碍 ≤6 等约束）
- `src/engine.ts` — 状态、着法生成、着法执行、状态键
- `src/solver.ts` — 显式栈 DFS + 记忆化、目标次序、检查点序列化/恢复
- `src/brute.ts` — 全状态 BFS 与无记忆化穷举（对照用）
- `src/certificate.ts` — 安全上界、证书生成与重放校验
- `src/app.ts` / `src/cli.ts` — CLI（逻辑可注入 IO，便于进程内测试）
- `test/` — `node --test` 测试；`examples/` — 示例棋盘
