# sync-plan

同步规划 CLI：按接收方已有区间与候选包的覆盖区间，选出**总字节最少**的包集合
覆盖全部缺口（至多 20 包），再生成满足**暂存内存上限**的下载/解码计划，并输出
可独立校验的覆盖证书与下载解码证书（含预算上下界）。

仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 模型约定

- 区间为半开区间 `[start, end)`；缺口 = `range − receiver`。
- **包原子不可拆**：覆盖同一缺口的包要么整个选取、要么不选，费用（下载字节）
  只计一次，包之间允许重叠覆盖。
- 包可通过 `needs` 依赖其他包的**解码字典**；被依赖包会被一并纳入下载集合
  （传递闭包），其下载字节计入下载总量。
- 内存模型：下载包 `i` 时占用 `bytes_i` 缓冲；解码时额外加载 `dictBytes_i`
  字典；解码后缓冲释放，字典驻留至最后一个直接依赖它的包解码完成后释放。
  任何事件边界上的驻留总量不得超过 `memoryLimit`。

## 算法

- **覆盖**：缺口与包覆盖求交后切分为基本段，以 `(包下标, 未覆盖位掩码, 剩余包预算)`
  做记忆化 DP 求精确最小费用；小实例（≤24 包）用全子集枚举交叉核对。
- **调度**：以"已解码集合"为状态做子集 DP（状态图穷举，`n ≤ 20` 时精确），
  最小化峰值内存；更大图退化为贪心。小状态图（`n ≤ 9`）用全排列枚举对照。
- **预算界**：下界 = `max_i (bytes_i + dictBytes_i + Σ 直接依赖字典)`（解码 `i`
  时其直接依赖字典必然驻留）；上界 = 所产出调度的实际峰值。精确模式下峰值即
  最优峰值。

## 用法

```sh
npm run build
node dist/src/cli.js plan examples/small.json --enumerate --out cert.json
node dist/src/cli.js verify examples/small.json cert.json
```

- `plan`：求解并输出 JSON 证书（stdout 或 `--out`）；覆盖或内存不可行时退出码 1。
- `verify`：独立重放校验证书（覆盖完备性、费用最优性、依赖顺序、逐事件内存、
  上下界、小实例穷举对照）；无效时退出码 2。
- `--enumerate`：全子集枚举核对覆盖最优性；`--no-bruteforce` 跳过全排列对照；
  `--max-packages N` 覆盖包数预算（默认 20）。

输入格式见 `examples/small.json`：`range` / `receiver` / `memoryLimit` /
`maxPackages` / `packages[{id, cover, bytes, dictBytes, needs}]`。

## 测试

```sh
npm test    # = tsc 构建 + node --test dist/test/*.test.js
```

测试覆盖：区间运算；覆盖 DP 与全子集枚举在 40+30 个随机小实例上对照；
重叠计费、包预算、同覆盖包原子性、不可行判定；调度子集 DP 与全排列穷举在
40 个随机小状态图上对照、下界 ≤ 峰值、释放时机、内存超限判定；CLI 端到端
（含子进程退出码）与篡改证书的拒绝。

### 实际结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
dist/test/cli.test.js       # tests 7   # pass 7   # fail 0
dist/test/cover.test.js     # tests 10  # pass 10  # fail 0
dist/test/intervals.test.js # tests 5   # pass 5   # fail 0
dist/test/schedule.test.js  # tests 7   # pass 7   # fail 0
合计 29 个测试全部通过。
```

`examples/small.json` 实跑：选 `A,C,D` 共 220 字节覆盖 65 缺口字节（枚举 31 个
子集核对一致）；调度顺序 `A → D → B → C`（B 为字典依赖被拉入），峰值 200 字节，
预算界 [200, 200]，上限 260，下载总量 300 字节，全排列对照一致。
