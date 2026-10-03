# kvstore — 嵌入式事务存储库

面向物理实验室观测记录管理的单机嵌入式键值存储：每条记录以目标名/观测键为 key,
测量值为 value,支持反复更正(每次更正产生新的版本),并保留全部历史版本。
仅使用 Node.js 22 标准库,无外部依赖,离线可用。

## 特性

- **事务**:`begin` / `put` / `delete` / `commit` / `abort`
- **MVCC 快照隔离**:读事务看到其 `begin` 时刻的一致性快照;`get(key, version)` 可读任意历史版本
- **写-写冲突检测**:写事务提交时,若其写集与快照之后已提交的并发事务写集相交,提交失败并抛出 `CONFLICT`
- **WAL 持久化**:所有写先落 append-only WAL(`store.wal`),数据记录 fsync 之后才写提交标记;提交记录带 CRC32 校验和
- **崩溃恢复**:启动时重放 WAL;无提交标记的数据记录被丢弃;尾部半条记录(长度不足/校验和错误)截断后继续

## WAL 记录格式

```
[u32 payload 长度][payload(JSON)][u32 CRC32(payload)]
```

- `{"t":"data","txn":<id>,"entries":[{"k":...,"v":...}]}` — 事务写集(`v` 为 `null` 表示删除)
- `{"t":"commit","txn":<id>,"ver":<n>}` — 提交标记,`ver` 为单调递增的全局版本号

提交流程:append data → fsync → **(故障注入点)** → append commit → fsync → 应用内存索引。
故障注入:设置环境变量 `KVSTORE_FAULT=afterDataFsync` 会在数据落盘后、写提交标记前
以 `process.exit(42)` 模拟进程被杀,用于崩溃恢复测试。

## 库 API

```js
const { Store } = require('./src/store');

Store.init('./data');            // 初始化存储目录
const store = new Store('./data');

const txn = store.begin();
txn.put('vega', 'mag=0.03');
txn.delete('old-key');
txn.commit();                    // 冲突时抛出 code === 'CONFLICT'
// txn.abort();                  // 放弃事务

store.get('vega');               // 当前版本
store.get('vega', 1);            // 历史快照(版本 1)
store.scan();                    // 当前全部键值(按键排序)
store.history('vega');           // 该键全部版本 [{version, value}, ...]
store.close();
```

## CLI

```bash
node cli.js [--dir <path>] <command> [args]

node cli.js --dir ./data init
node cli.js --dir ./data put vega mag=0.03        # -> OK version=1
node cli.js --dir ./data get vega                 # -> mag=0.03
node cli.js --dir ./data get vega --at 1          # 读历史快照
node cli.js --dir ./data del vega
node cli.js --dir ./data scan [--at 2]            # 全量扫描,可带历史版本
node cli.js --dir ./data history vega             # 版本历史,删除显示 DELETED
```

## 错误约定

| 错误码      | 含义                     | 退出码 |
| ----------- | ------------------------ | ------ |
| `NOT_FOUND` | 键不存在                 | 2      |
| `INVALID`   | 参数非法/未知命令        | 1      |
| `CONFLICT`  | 写集冲突(库层抛出)     | 3      |

CLI 错误输出格式:`ERROR <CODE>: <message>`(stderr)。

## 测试

```bash
node --test
```

覆盖三个验收场景:

1. **并发冲突**(`test/conflict.test.js`):两个并发写事务改同一键,后提交者收到
   `CONFLICT`;写集不相交时两者都可提交;读事务看到 begin 时刻快照。
2. **崩溃恢复**(`test/crash.test.js`):子进程在 fsync 后、写提交标记前被
   `process.exit(42)` 杀死,重启后该事务不可见、之前事务完整,且 WAL 截断后可继续
   追加;另覆盖尾部半条记录与校验和损坏两种截断场景。
3. **随机模型对照**(`test/model.test.js`):固定种子 PRNG 对 200 个键执行 500 个
   随机操作(put/delete/历史快照读/事务内读/重开存储),与内存 Map 参考模型逐键、
   逐版本对照,并对全部 200 键 × 全部历史版本做终态穷举校验。

另有 `test/cli.test.js` 覆盖 CLI 全命令与错误约定。

### 真实测试结果(2026-10-03,Node v22.22.1)

```
$ node --test
# tests 4        (测试文件)
# pass 4
# fail 0
```

逐文件:`cli.test.js` 2/2,`conflict.test.js` 5/5,`crash.test.js` 3/3,
`model.test.js` 1/1 —— 共 11 个用例全部通过。

注:测试环境沙箱无法从孙进程管道回读 stdio(spawnSync 报 EPERM),子进程测试通过
`test-support/helpers.js` 将 stdout/stderr 重定向到临时文件采集,不影响被测逻辑。

## 限制

- 单进程写:WAL 追加未加跨进程文件锁,CLI 并发写同一目录需调用方自行串行化。
- 恢复时全量重放 WAL 到内存索引,适合实验记录规模;未做压缩/快照截断。
