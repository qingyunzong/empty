# lineage-proof

成品/原料谱系可达性证明系统。仅依赖 Node.js 22 标准库，离线单机运行。

## 库 API（`src/index.js`）

- `build(nodes, edges)` → store `{ version, graph, registry }`
- `prove_reach(store, s, t, { ttlMs, now })` → `{ ok, cert }` 或 `{ ok: false, code }`
- `prove_nonreach(store, s, t, { ttlMs, now })` → 同上
- `verify(store, proof, { now })` → `VALID | CERT_INVALID | NO_SUCH_NODE | VERSION_MISMATCH`
- `locate_contamination(store, sources, t)` → 首条污染边与污染路径

## CLI

```sh
node cli.js build --graph graph.json --store store.json
node cli.js prove_reach    --store store.json --s M1 --t P [--ttl 3600] [--out proof.json]
node cli.js prove_nonreach --store store.json --s P --t M1 [--out proof.json]
node cli.js verify --store store.json --proof proof.json
node cli.js locate --store store.json --sources M1,M2 --t P
```

`graph.json` 形如 `{"nodes": [...], "edges": [["A","B"], ...]}`（边也接受 `{"from","to"}`）。

## 测试

```sh
node --test
```

详见 `RESULTS.md`（真实运行结果）。
