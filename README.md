# jumpforge — 自定义跳吃棋盘求解 CLI

求解一个**自定义规则**（不借用任何现实棋类）的跳吃谜题：在矩形棋盘上移动跳子，
直线跳过相邻敌子落到空格即删除该敌子，可连跳。目标为**最多捕获**；捕获数并列时
取**落点序列字典序最小**（按 `(x,y)` 先比 x 再比 y 逐格比较）的方案。

## 规则（完整、自洽）

- 棋盘 `width × height`，坐标 `(x,y)` 从 `(0,0)` 开始。边界即墙，另可配置静态墙 `walls`。
- 棋子：`P` 跳子 1 枚；`E` 敌子 ≤ 12 枚；`O` 可推障碍 ≤ 6 块；`T` 开关格恰好 0 或 1 个。
- 每步可执行三类动作之一：
  - **步进（step）**：正交（上下左右）移动一格到空格。
  - **推障（push）**：正交相邻格有障碍且障碍后方一格为空（在界内、非墙、无棋子）时，
    障碍被推到后方格，跳子进入障碍原格。
  - **跳吃（jump）**：在当前**方向集合**中任取方向 `d`，若 `P+d` 有敌子且 `P+2d`
    为空格，则删除该敌子并落于 `P+2d`。连跳通过连续选择跳吃动作自然形成。
- **开关格**：跳子因任何动作**落**在开关格上时，跳跃方向集合在 `directionsA`（相位 0）
  与 `directionsB`（相位 1）之间切换；切换会改变此后（以及此前可用的）可跳位置。
  - `toggleOnce: true` 时开关只生效一次（首次落入后永久失效）；
    默认（`false`）为每次落入都翻转。
  - 障碍/敌子经过或停在开关格上不触发；仅跳子落入触发。
- 敌子被吃即永久移除；障碍不可被吃、不可重叠。

## 输入格式（JSON）

```json
{
  "width": 5, "height": 5,
  "player": [0, 4],
  "enemies": [[0, 3]],
  "obstacles": [[2, 1]],
  "walls": [[4, 0]],
  "toggle": [1, 4],
  "toggleOnce": false,
  "directionsA": [[1, 0]],
  "directionsB": [[1, 0], [0, -1]]
}
```

`obstacles` / `walls` / `toggle` / `toggleOnce` / `directionsB` 均可省略
（`directionsB` 缺省等于 `directionsA`）。敌子超过 12、障碍超过 6 会被拒绝。

## 使用

```bash
npm run solve -- examples/line.json                 # 逐步盘面 + 证书
npm run solve -- examples/toggle.json --json        # 仅输出证书 JSON
npm run solve -- puzzle.json --max-states 100000 --snapshot snap.json
npm run solve -- puzzle.json --resume snap.json     # 从快照恢复继续搜索
npm test                                            # 编译并运行全部测试
npm run typecheck                                   # 严格类型检查
```

退出码：`0` 成功；`1` 输入/校验错误；`2` 达到 `--max-states` 上限
（若给了 `--snapshot` 会保存进度快照，可用 `--resume` 继续）。

## 最优捕获证书与安全上界

`--json` 输出的证书字段：

- `optimal`：最优捕获数（搜索完成后 `proved: true`，即已证明无更优）。
- `safetyUpperBound`：**安全上界** = 已捕获数 + 满足静态几何必要条件的剩余敌子数
  （存在某相位方向 `d` 使起跳格与落格都在界内且非墙）。恒有 `optimal ≤ safetyUpperBound ≤ 12`。
- `landings`：落点序列（每次跳吃的落格，按序）。
- `actions`：完整动作序列（含步进/推障），可确定性重放。
- `finalStateKey`：末态规范哈希；`statesExplored`：搜索状态数。

`verifyCertificate`（`src/certificate.ts`）会重放动作序列并校验捕获数、落点序列与末态哈希。

## 求解与核验方法

- **求解器**（`src/search.ts`）：对每个状态先做"零捕获闭包" BFS（仅步进/推障到达的所有状态），
  再枚举闭包中每个状态的跳吃并递归取优；按状态规范键记忆化。目标先最大化捕获数，
  再最小化落点序列字典序。`Solver.memo` 可导出/导入，实现**搜索状态保存与恢复**。
- **状态枚举核验**（`src/enumerate.ts`）：
  - `enumerateAll`：从初态对全部动作做 BFS，枚举完整状态图，独立给出可达最大捕获数；
  - `bruteForce`：对小棋盘做无重复状态路径 DFS，独立给出最优 (捕获数, 落点序列)。
  - 测试在随机小棋盘上对照三者（求解器 == 全状态枚举 == 暴力路径），并校验动作重放。

## 项目结构

- `src/types.ts` / `src/state.ts`：类型与状态规范序列化（保存/恢复的基础）。
- `src/board.ts`：谜题校验（尺寸、重叠、12 敌 / 6 障碍上限等）。
- `src/moves.ts`：动作生成、应用与合法性重放（`simulate`）。
- `src/search.ts`：记忆化最优搜索 + 安全上界。
- `src/enumerate.ts`：全状态枚举与暴力对照。
- `src/certificate.ts`：证书构造与校验。
- `src/render.ts` / `src/cli.ts`：盘面渲染与命令行（`runCli` 可注入 IO，便于测试）。
- `examples/`：三个示例（连跳、开关解锁方向、推障清落点）。
- `tests/`：6 个测试文件（状态、动作、搜索、枚举对照、快照恢复、CLI）。
