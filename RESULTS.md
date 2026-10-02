# 真实测试记录(node --test 全量)

环境:Node.js v22.22.1,Linux,单机离线,仅标准库。
命令:`node --test`(2026-10-03 运行,原始 TAP 摘要如下)

```
ok 1 - test/cli.test.js
ok 2 - test/machine.test.js
ok 3 - test/recovery.test.js
# tests 3
# pass 3
# fail 0
# duration_ms 112693.0869
```

子测试合计 19/19 通过:

- test/machine.test.js (8)
  - acceptance 4: 深度≤3 全枚举(1728 步)与参考状态机逐步对照
  - acceptance 4: 300 条长度 12 的定种子随机游走逐步对照
  - acceptance 2: 报废墓碑阻断返工与重开
  - acceptance 3: 复检更正只扩散到受影响序列(impactSet=['n5','n6'])
  - 更正为报废只墓碑受影响缺陷
  - 未闭环 undo 生效并留审计
  - 闭环后 undo 抛 exit 21
  - 索引派生计数精确
- test/recovery.test.js (9)
  - acceptance 1a: wal-append 崩溃 → 截断撕裂尾部并重放 WAL
  - acceptance 1b: snapshot-rename 崩溃 → 忽略半快照
  - acceptance 1c: index-update 崩溃 → 重建索引无双计(4→2)
  - exit 22: WAL 中部校验和失败
  - exit 23: 篡改操作+重修 crc 后哈希链断裂
  - exit 21: CLI 闭环后 undo
  - acceptance 2 (CLI): 报废后 rework/open 均被墓碑阻断
  - acceptance 3 (CLI): correct 输出受影响序列 impactSet
  - 未闭环 undo 留审计且 verify 通过
- test/cli.test.js (2)
  - 完整闭环: open→rework→close fail→rework→close pass→verify 哈希一致
  - 用法错误非零退出并带消息
