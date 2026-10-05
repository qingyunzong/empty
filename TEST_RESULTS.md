# npm test 实际结果

日期: 2026-10-05 12:52:08 CST
Node: v22.22.1  tsc: Version 7.0.2

```

> execution-diagnosis@0.1.0 test
> tsc -p tsconfig.json && node --test "build/test/*.test.js"

TAP version 13
# Subtest: build/test/diagnose.test.js
ok 1 - build/test/diagnose.test.js
  ---
  duration_ms: 390.208917
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 422.816466
```

## 测试文件内明细（node build/test/diagnose.test.js）

```
ok 1 - 有限表穷举核对：kind × status 全组合分类一致
ok 2 - 诊断类别集合恰为四类
ok 3 - 没有执行证据（空输入）→ unknown
ok 4 - 有执行证据但无致终止事件 → unknown
ok 5 - 前置缺失分类
ok 6 - 通信中断分类（failed / timeout / interrupted 三态）
ok 7 - 断言失败分类
ok 8 - 多原因按最早直接致终止事件（与输入顺序无关）
ok 9 - 不从文字猜身份：message 含他类字样不改变分类
ok 10 - 不从文字猜身份：kind 越出有限表即拒绝，不做推断
ok 11 - 因果链：有 causedBy 引用时回溯完整祖先链
ok 12 - 因果链：无 causedBy 时退化为致终止事件前的时序记录
ok 13 - 非法输入一律拒绝：非数组、缺字段、重复 seq、非法 causedBy
# tests 13
# pass 13
# fail 0
```
