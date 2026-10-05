# mbt — 有限协议状态表的模型化测试 CLI

给定有限协议状态表（JSON）与实现适配器（子进程），自动生成长度至多
`n` 步的合法动作序列，按**最短历史**回放定位每个状态，并报告实现与
模型的**状态差异**；非法动作单独探测：必须报错且不得改变状态。
每次实际适配器调用的输出都保留在报告中；步数预算未闭合（存在未覆盖
的迁移或不可达状态）时绝不判定 PASS，而是 INCONCLUSIVE。

仅使用 Go 标准库。

## 用法

```sh
go build -o mbt ./cmd/mbt
./mbt run -model examples/turnstile/model.json -n 3 -- ./turnstile-adapter
```

退出码：`0`=PASS，`1`=FAIL，`2`=用法/IO 错误，`3`=INCONCLUSIVE（预算未闭合）。
`-report FILE` 可将 JSON 报告写入文件而非 stdout。

## 状态表格式

```json
{
  "initial": "locked",
  "states": { "locked": {"data": {...}}, "unlocked": {} },
  "transitions": [
    {"from": "locked", "action": "coin", "to": "unlocked"}
  ]
}
```

`states.<name>.data` 声明该状态应观测到的数据键；实现额外上报的键不
参与比较。某状态未列出的动作即为该状态的非法动作。

## 适配器协议（JSON lines）

适配器是被测实现的子进程：stdin 每行一个请求，stdout 每行一个响应。

- 请求：`{"op":"reset"}` / `{"op":"state"}` / `{"op":"apply","action":"coin"}`
- 响应：`{"ok":true,"state":"locked","data":{...}}` 或
  `{"ok":false,"error":"..."}`（非法动作必须如此应答，且状态不变）

参考实现见 `cmd/turnstile-adapter`。

## 判定逻辑

1. BFS 计算每个可达状态的最短动作历史。
2. 对每条迁移生成覆盖序列（到达 from 的最短历史 + 该动作），长度
   超过 `n` 的迁移记为未覆盖 → 预算不闭合。
3. 逐条回放序列，记录每次实际调用输出，比对目标状态与声明数据，
   产出差异（`state: want ... got ...` / `data[k]: want ... got ...`）。
4. 对每个预算内可达状态，逐一探测非法动作：必须被拒绝且随后查询
   到的状态与数据不变。
5. 有任何失败 → FAIL；无失败但预算未闭合 → INCONCLUSIVE（不写
   PASS）；否则 PASS。

## 测试

```sh
go test ./...
```

最近一次实际运行结果（记录于 `examples/turnstile/actual/go-test-output.txt`）：

```
ok  	mbt/cmd/mbt
?   	mbt/cmd/turnstile-adapter	[no test files]
ok  	mbt/mbt
```

示例真实运行输出保留在 `examples/turnstile/actual/`：
`report-pass-n3.json`（PASS，退出码 0）与
`report-inconclusive-n1.json`（预算未闭合，退出码 3）。
