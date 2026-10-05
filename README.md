# 两阶段事务（2PC）模拟器

TypeScript + Node.js 内置库实现，零第三方依赖。模拟两阶段提交协议，
所有准备（PREPARE）与决议（DECISION）记录先落盘（append + fsync）再应答，
协调者重启后只沿日志记录续行，未决事务绝不冒充回滚，重复投票幂等，
并附带独立状态检查器核对所有参与者决议一致。

## 运行

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行全部用例
```

## 结构

- `src/wal.ts` — 预写日志：每条记录 JSON 追加并 fsync，恢复即顺序扫描。
- `src/coordinator.ts` — 协调者。BEGIN / VOTE / DECISION 全部先落盘。
  恢复时仅依据日志：有 DECISION 则重投决议；无则按日志重新收集选票，
  有 NO 才记 ABORT，全员 YES 才记 COMMIT，否则保持 PENDING（不编造回滚）。
- `src/participant.ts` — 参与者。投票与决议应用先落盘再应答；
  重复 PREPARE / DECISION 直接回放已记录状态，幂等。
- `src/hub.ts` — 同步内存消息枢纽，支持节点下线（消息丢失）与重复投递。
- `src/checker.ts` — 独立检查器：直接从磁盘读所有日志文件（不经过节点
  实现），校验：无伪造回滚、COMMIT 需全员 YES、参与者决议与协调者一致、
  任意两参与者结局不分歧；`requireQuiescent` 模式还要求全部事务收敛。

## 测试覆盖（test/tpc.test.ts）

1. 全员 YES 正常提交；2. 一票 NO 全局回滚；3. 重复投递幂等；
4. 协调者记下 COMMIT 后崩溃，重启沿日志续行；5. 第一阶段中途崩溃，
   重启幂等重收集选票；6. 参与者失联时事务保持 PENDING，绝不冒充回滚，
   恢复后正常提交；7. 枚举协调者每个落盘点崩溃，恢复后均一致收敛；
8. 参与者记下 PREPARED 后崩溃，重启回放已记录选票；
9–10. 检查器能检出伪造回滚与参与者决议分歧。
