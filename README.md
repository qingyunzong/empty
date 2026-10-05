# command-session-parser

交互式命令会话的增量解析库（TypeScript，仅依赖 Node.js 内置模块）。

## 功能

- **保留发送字节**：`send()` / `sendCommand()` 记录写入会话的全部字节及偏移。
- **区分回显与程序输出**：接收流按发送队列严格匹配；回显绝不计入
  `getResult()` 的程序结果。回显尚未开始的命令遇到不匹配字符时按输出处理；
  回显已开始却中途发散的命令立即标记为未完成。
- **公开有限控制序列表**：`CONTROL_SEQUENCES`（`src/controlSequences.ts`）
  是唯一生效的序列表——5 个 C0 控制符（LF/CR/BS/TAB/BEL）与 8 个 CSI
  序列（C/D/G/H/J/K/P/@）。表外序列（SGR、OSC、私有序列等）被消费并丢弃，
  不会进入可见文本、回显或结果。
- **截断命令标未完成**：`end()` 时回显未收齐的命令，以及回显中途发散的
  命令，状态均为 `incomplete`；接收流在控制序列中途结束时
  `isTruncated()` 为真。
- **切块无关性**：`feed()` 接受任意大小的块（含拆分多字节 UTF-8 与 CSI
  序列）；可见文本、段（segment）的原始字节偏移、命令状态与整块喂入
  完全一致。偏移均为原始接收字节流中的字节偏移。

## API 摘要

```ts
import { SessionParser, CONTROL_SEQUENCES } from 'command-session-parser';

const p = new SessionParser();
p.sendCommand('echo hi');        // 记录发送字节 'echo hi\r'
p.feed('echo hi\r\nhi\r\n');     // 任意切块喂入接收流
p.end();
p.getVisibleText();              // 'echo hi\nhi\n'（含回显的可见文本）
p.getResult();                   // 'hi'（仅程序输出，绝不含回显）
p.getSegments();                 // [{ kind: 'echo'|'output', text, start, end }]
p.getCommands();                 // [{ command, sent, sentOffset, echo, output, status }]
p.getSentBytes();                // 'echo hi\r'
```

## 脚本

- `npm test` — 用 `tsc` 编译后运行 `node --test`（Node 内置测试运行器）。
- `npm run typecheck` — `tsc --noEmit` 严格类型检查。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-06 实测。

`npm test` 输出：

```
> command-session-parser@0.1.0 test
> tsc -p tsconfig.build.json && node --test dist/test/parser.test.js

TAP version 13
# Subtest: dist/test/parser.test.js
ok 1 - dist/test/parser.test.js
  ---
  duration_ms: 1550.480613
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
# duration_ms 1671.973791
```

逐用例（`node --test-reporter=spec dist/test/parser.test.js`）：

```
✔ public control-sequence table is finite and complete (15.570938ms)
✔ echo is kept apart from the program result (9.736575ms)
✔ sent bytes are retained across multiple commands (1.574367ms)
✔ raw sent bytes are retained and matched as echo (3.643162ms)
✔ control sequences from the table shape the visible text (3.340529ms)
✔ sequences outside the table are consumed and ignored (1.674554ms)
✔ truncated command is marked incomplete at end() (1.019918ms)
✔ echo mismatch marks the command incomplete and stays output (1.258324ms)
✔ echo diverging mid-command marks the command incomplete (1.830897ms)
✔ stream ending mid control sequence is flagged truncated (2.343047ms)
✔ segment offsets point into the original received stream (4.05642ms)
✔ arbitrary chunking matches whole-block interpretation (119.463389ms)
✔ every two-way split of a tricky stream matches the whole (9.343209ms)
✔ visible text and result for a realistic session (1.859427ms)
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

其中切块无关性由 200 组确定性随机切块（含逐字节切分 UTF-8 与 CSI
序列）加一条棘手流的全部二切分（逐字节每个切点）与整块解释逐一
深比较验证。
