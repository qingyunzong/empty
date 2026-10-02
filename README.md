# arbiter — 多观测员更正历史裁决库及 CLI

单机离线、Node.js 22、仅标准库。输入为事件日志（节点 ID、逻辑时钟、观测键、值），
词法器区分结构化事件行与 `note:` 自由文本，编译为字节码（COMMIT / MASK / ROLLBACK /
CONFLICT）后由虚拟机重放。

## 日志格式

```
evt node=<id> clock=<n> seq=<n> op=<commit|mask|rollback> key=<k> [value=<v>]
note: <自由文本，不参与执行>
```

## 裁决规则（happens-before）

- `a.clock < b.clock` 则 `a -> b`（同节点因果在前；跨节点按时钟）。
- 时钟相等（必为不同节点）→ 并发。同键并发写且值不同 → conflict，拒绝任意选择，
  重放在冲突处停止：已提交前缀保留，冲突事件不入状态，输出冲突证书。
- 不同键并发 → 按键名字典序（再按节点、序号）确定顺序，结果唯一确定。
- 每个事件只生效一次：重复 `(node, clock)` 或 `(node, seq)` 拒绝；缺时钟报错。

## 使用

```
node cli.js <logfile> [--explain]   # --explain 输出因果边（传递约简）与确定顺序
node --test                          # 运行验收测试
```

退出码：0 成功（含冲突证书）；65 数据错误（缺时钟/重复事件等）；64 用法错误；66 文件不可读。

## 结构

- `src/lexer.js` — 词法器：事件行 vs `note:` 自由文本
- `src/parser.js` — 校验：必填字段、时钟/序号、去重
- `src/compiler.js` — 因果边、确定性拓扑序、冲突检测 → 字节码
- `src/vm.js` — 重放：commit/mask/rollback，冲突时停止并保留前缀
- `test/acceptance.test.js` — 三条验收标准及补充行为
