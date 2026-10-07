# route-lib

离线工艺路线库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 功能

- **分块编码**：工艺图（节点 + 有向边）编码为 META / INDEX / NODES 块，每块带 CRC32；索引块保存每个节点的字节偏移，支持随机访问（`getNode`）。
- **增量解码**：`decodeIncremental` 逐块校验并构建图；某块损坏时，损坏点之前的公共前缀仍可查询。
- **最优路径**：`findBestPath` 在满足工序先后（有向无环）与设备日负荷的路径中，选总加工时间最短者，并列时取节点序列字典序最小者。环报 `E_CYCLE`，容量不足报 `E_CAPACITY`，不可达报 `E_NO_PATH`。
- **乐观并发提交**：`Store.commit` 携带基版本与读集；若读集节点被他处修改则抛 `E_CONFLICT`，不自动合并。冲突证书包含双方版本哈希、读集、冲突节点与最终公共祖先，内容确定（稳定）。

## CLI

```
node src/cli.js init <storeDir>
node src/cli.js build <graph.json> <out.bin> [--chunk-size N]
node src/cli.js query <file.bin> <start> <end>
node src/cli.js node <file.bin> <nodeId>
node src/cli.js verify <file.bin>
node src/cli.js commit <storeDir> <baseHash|-> <graph.json> --read a,b --write a,b
node src/cli.js log <storeDir>
```

退出码：0 成功；1 用法错误；2 路径/基版本错误（`E_CYCLE`/`E_CAPACITY`/`E_NO_PATH`/`E_UNKNOWN_BASE`）；3 提交冲突（stdout 输出冲突证书 JSON）；4 数据损坏。

## 测试

```
node --test
```
