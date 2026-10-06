# gen-session-router

带节点代际（generation）的会话路由库。

## 语义

- **会话绑定节点代际**：每个节点维护单调递增的代际号（故障恢复时 +1），会话在建立时绑定到节点的当前代际，负载按 `(节点, 代际)` 分别计数。
- **按权重最小负载选路**：新会话选择 `当前代际负载 / 权重` 最小的健康节点，并列时按节点 id 字典序。
- **故障才切换**：仅当会话绑定的 `(节点, 代际)` 失效（节点不健康或代际已过期）时才重连到当前最优节点；恢复上线的节点不会抢回已有会话，只吸引新会话。
- **关闭只减对应代际**：`closeSession` 只递减会话绑定代际的负载计数，不触碰该节点其他代际。
- **批量健康事件原子应用**：`applyHealthEvents` 先校验整批事件（未知节点则整批拒绝、状态不变），再统一应用；随后扫描会话表重连失效绑定，最后用会话表重算各代际负载并核验增量计数，保证重连与旧关闭的记账一致。

## 使用

```ts
import { Router } from "gen-session-router";

const router = new Router();
router.addNode("a", 2);
router.addNode("b", 1);

const s = router.openSession();      // { id, nodeId, generation }
router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
router.closeSession(s.id);
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```
