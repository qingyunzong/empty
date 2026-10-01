# Saga 树状订单预留模拟器

输入 JSON 为树状订单：根节点下有航班、酒店、租车等子节点，酒店可含多个房间；
每节点带预留（reserve）/补偿（compensate）动作及估价（cost）。纯 Python 3.11
标准库实现，测试使用 unittest。

## 订单格式

```json
{
  "budget": 1000,
  "order": {
    "name": "root", "cost": 0,
    "children": [
      {"name": "flight", "cost": 300},
      {"name": "hotel", "cost": 0, "children": [
        {"name": "room1", "cost": 200},
        {"name": "room2", "cost": 200}
      ]},
      {"name": "car", "cost": 100}
    ]
  }
}
```

## 语义

1. 按深度优先、从左到右（先序）依次预留。
2. 某节点失败时，先逆序补偿其已完成子节点，再向上冒泡，由父节点逆序补偿
   此前已成功的同级节点（祖先节点本身不补偿）。
3. 总估价超过预算时，在任何外部动作之前失败（日志为空，状态 FAILED）。
4. 预留按节点路径幂等：已确认的路径跳过，重复运行不产生重复预留。
5. 崩溃后恢复：跳过已确认动作，重放未确认动作（重放事件带 `replays` 标记）。

状态机：`RUNNING → COMPLETED`；失败时 `RUNNING → COMPENSATING → COMPENSATED`；
超预算直接 `FAILED`；崩溃时停留在 `RUNNING`/`COMPENSATING` 并标记 crashed。

## CLI

会话状态持久化在 `.saga_session.json`（可用 `--state-file` 或环境变量
`SAGA_STATE_FILE` 覆盖）。

```sh
python3 saga.py run order.json                 # 执行预留
python3 saga.py run order.json                 # 重复运行：幂等，无新事件
python3 saga.py fail-at room2                  # 配置失败节点
python3 saga.py run order.json --reset         # 重新运行：补偿 room1、flight
python3 saga.py crash --at 4                   # 配置在第 4 个事件处崩溃
python3 saga.py run order.json --reset         # 运行并在事件 4 崩溃
python3 saga.py recover                        # 恢复：重放未确认动作
python3 saga.py state                          # 查看状态与日志
```

`run` 也支持 `--fail-at NODE`、`--crash-at EVENT`、`--budget N` 直接传参。

## 测试

```sh
python3 -m unittest test_saga -v
```

`test_saga.py` 内含独立的小型参考递归算法 `reference_rollback`（先逆序补偿
失败节点的已完成子节点，再逐级向上冒泡补偿已成功同级节点），与实现采用的
“逆预留顺序减去失败节点祖先”构造互相校验精确回滚序列；另含 CLI 子进程
集成测试。最近一次真实运行：11 个测试全部通过，退出码 0。
