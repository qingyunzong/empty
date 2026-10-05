# scenario — 最小失败子序列检测 CLI

## 语义

- 每个事件声明 `reads` / `writes` 资源集合；场景事件数上限 20（`MaxEvents`）。
- **前置检查（合法性）**：子序列保持原事件相对顺序，某事件读取的每个资源必须是
  `Initial` 或由子序列中更早的保留事件写入，否则子序列非法。
- **失败判定**：子序列合法 **且** 包含目标事件（`Target`）。非法子序列不算失败。
- **目标**：求保留失败的最少事件子序列（最小基数）。

## 算法

- 阶段 1：`MinFailing` 按子序列大小 1..n 递增、同大小按字典序逐个检测，
  首个失败候选即为最小；每个候选的 `(子序列, legal, fail)` 全部记入证据。
- 阶段 2：`EnumerateAll` 枚举全部 2^n 个子序列（n ≤ 20，约 104 万）交叉核对最小性。
- 另验证结果的 1-极小性：删除任一单事件后不再失败。

## 用法

```sh
go build -o scenario .
./scenario -list                       # 列出内置场景
./scenario -scenario small             # 全量检测证据（默认 -evidence=full）
./scenario -scenario chain20 -evidence=summary
./scenario -scenario impossible        # 无失败子序列的情形
```

内置场景：`small`(5)、`fork`(6)、`chain20`(20，恰为上限)、`impossible`(4，无解)。

## 实际运行记录（Go 1.27.1, linux/amd64）

`go test ./...`：

```
ok  	scenario	5.743s
```

8 个测试全部通过，包括：上限校验、非法不算失败、内置场景最小值
（small=4, fork=2, chain20=4, impossible=无解）、全枚举交叉核对、
200 个确定性随机场景交叉核对、证据完整性（按大小递增、止于首个失败）。

CLI 实测：

- `small`：搜索 27 个候选得最小 `[load-cfg init-db init-cache crash]`（4），
  枚举全部 32 个子序列（2 个失败）核对一致，1-极小性 true。
- `chain20`：搜索 6195 个候选得 `[step1 step2 step3 crash]`（4），
  枚举全部 1,048,576 个子序列（65,536 个失败）核对一致。
- `impossible`：搜索 16 个候选无失败，枚举核对一致（双方均判定无解）。
