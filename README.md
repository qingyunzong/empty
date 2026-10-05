# histcli — 三节点交付日志前缀一致性检查

检查三个节点的交付日志是否**同序前缀一致**：任意两份日志之间，一份必须是另一份的前缀。

- 已崩溃（`crashed`）节点允许持有更短的前缀；但出现分叉条目仍算冲突。
- 状态未知（`unknown`）的节点短前缀**不计为故障**。
- 存活（`alive`）节点短前缀计为故障（`SHORT_PREFIX`）。
- 冲突时报告**最早冲突位置**及**两份来源**（该位置上字典序最小的节点对）。
- `append` 支持**增量追加**：检查器维护增量状态，每次追加后与**全对比较模型**（all-pairs）核对，结果不一致即报错退出。

仅使用 Go 标准库。

## 用法

```sh
go build -o histcli .

# 初始化三节点状态（状态：alive|crashed|unknown）
./histcli init -state st.json -node n1=alive -node n2=crashed -node n3=unknown

# 增量追加条目（SEQ 必须严格递增）
./histcli append -state st.json -node n1 -entry 1:a -entry 2:b -entry 3:c

# 全量检查当前状态
./histcli check -state st.json
```

输出示例（冲突）：

```
cross-check: incremental == full model
verdict: CONFLICT
earliest conflict: index 2
sources: n1, n2
  n1: seq=3 value="c"
  n2: seq=3 value="X"
```

## 设计

- `logcheck.FullReport`：全对比较模型，枚举所有节点对找最早分叉。
- `logcheck.Checker`：增量模型。维护"参考日志"（最长日志，并列取 ID 最小者）
  及各节点相对参考日志的最早分叉位置；追加时只比较新增区间，参考日志
  切换为干净扩展时分叉索引直接继承，否则重建。可证明：任取最长日志作参考，
  "全体节点对参考的最小分叉位置"等于"所有节点对的最小分叉位置"，故两模型
  的最早冲突一致；冲突来源取该位置上字典序最小的分叉节点对。
- 每次 `init`/`append`/`check` 都会同时运行两个模型并比对报告。

## 测试结果（实际运行记录）

`go test ./... -count=1`（go1.27.1 linux/amd64）：

```
?   	histcli	[no test files]
ok  	histcli/logcheck	0.074s
```

11 个测试全部通过，含随机化核对：200 轮 × 40 步随机追加后，增量模型与
全对比较模型（含从头重建的检查器）报告逐一相等。
