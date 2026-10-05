# logrestore

从检查点版本和多个重叠日志段恢复日志一条连续日志。

## 规则

- 同序号同内容：去重，只保留一条（记录首个来源段）。
- 同序号异内容：拒绝恢复，报 `ConflictError`（退出码 2）。
- 只应用检查点之后的连续前缀（checkpoint+1, +2, ...）。
- 前缀之后仍有更高序号时构成缺口：拒绝恢复（退出码 1），
  并输出首个缺失序号及缺口之后日志所在的来源段。
- 序号 ≤ 检查点的条目直接忽略（其内容冲突也不检查）。

## 用法

```sh
logrestore -checkpoint N seg1.log seg2.log ...
logrestore -checkpoint-file state.txt seg1.log seg2.log ...
```

段文件每行一条：`<seq> <content>`。应用的条目输出到 stdout，
来源段可用 `-v` 打印到 stderr。

## 测试

`restore` 包含单元测试与随机化对照测试：把完整日志随机分割成
重叠段并打乱顺序，`Restore` 的结果必须与完整日志解释器
`InterpretFull` 完全一致；带洞分割时校验首个缺失序号与来源段。

实际运行结果（go1.27.1, 2026-10-06）：

```
$ go test ./...
?   	logrestore/cmd/logrestore	[no test files]
ok  	logrestore/restore	0.075s
```

7 个测试全部 PASS（含 2×200 个随机种子的对照测试）。
