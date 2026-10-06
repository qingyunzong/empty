# logrule

日志规则引擎库（仅使用 Go 标准库）。

## 语义

- **规则动态更换，按记录序号生效**：`ReplaceRules(effectiveSeq, rules)` 安装一代规则，
  对 `Seq >= effectiveSeq` 的记录生效；每条记录解析到其序号下最新的一代。
- **同记录全部规则同代**：处理单条记录时，其全部匹配规则都来自同一代不可变快照
  （`Node.Gen` 记录所用代的 id）。
- **派生诊断但不能再次匹配原记录**：规则的 `Derive` 可派生诊断记录，派生记录自身
  照常参与匹配；但与任一祖先记录相同的派生记录被抑制（`NoteRematch`），
  不会再次匹配，原记录绝不会被重新处理。
- **派生深度预算明确**：`NewEngine(maxDepth)` 设定派生记录可存在的最大深度
  （原记录深度为 0）。深度耗尽的节点仍参与匹配，但其派生结果被丢弃并标注
  `NoteDepthBudget`。
- **来源树**：`Process` 返回 `*Node` 来源树，`Node.String()` 输出缩进树形文本。
- **参考递归解释器核对**：`Interpret` 是递归参考实现；随机化测试
  `TestProcessMatchesReferenceInterpreter`（5000 组随机代际/规则/记录）核对迭代式
  `Process` 与递归 `Interpret` 产出的来源树完全一致。

## 实测结果

环境：`go version go1.27.1 linux/amd64`

```
$ go test ./...
ok  	logrule	0.044s
```

全部 7 个测试 + 1 个示例通过：

```
--- PASS: TestGenerationEffectiveBySeq
--- PASS: TestSameRecordSingleGeneration
--- PASS: TestReplaceRulesInPlace
--- PASS: TestDerivedDiagnosticsMatchButNeverRematchAncestor
--- PASS: TestDepthBudget
--- PASS: TestProvenanceTreeString
--- PASS: TestProcessMatchesReferenceInterpreter
--- PASS: Example
```
