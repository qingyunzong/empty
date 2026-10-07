# dir-index-cli

扫描目录生成**可比较的内容清单**（相对路径 + 条目类型 + sha256 内容哈希），
支持带证据校验的缓存复用与受控修改核验。

## 行为保证

- **符号链接不跟随**：一律使用 `lstat`；符号链接只记录其原始目标
  （`linkTarget`），不读取目标内容、不遍历链接目录、不越出根目录。
- **扫描期间变更重试有限次并标不稳定**：哈希文件时在读前/读后各取一次
  `lstat` 证据（size/mtime/ctime/ino），不一致则重试，默认最多 3 次
  （`--retries` 可调）；仍不稳定则条目标记 `unstable: true` 并输出警告。
- **缓存仅在内容证据一致时复用**：缓存条目同时满足同路径、同类型、
  非 unstable 且证据（size + mtimeMs + ctimeMs + ino）完全一致时才复用
  哈希。ctime/ino 无法被 `utimes` 等用户态手段伪造，因此"同尺寸改写 +
  恢复 mtime"的受控修改不会命中缓存，**不会报伪相等**。
- **可比较清单**：`serializeManifest` 输出规范化 JSON（剔除 root/
  createdAt 等易变元数据，条目按路径排序、键序固定），可直接文本对比；
  `compareManifests` / `dir-index diff` 给出 added/removed/changed 差异。
  清单相等性只关乎内容身份（类型、哈希、链接目标、稳定性），证据仅作
  缓存元数据，不参与相等判断。

## 构建与测试

需要 Node.js >= 18 与可用的 `tsc`（本仓库零运行时依赖；环境无
`@types/node`，`types/node-shims.d.ts` 自带最小类型声明）。

```sh
npm run build   # tsc 编译到 dist/
npm test        # 编译并运行 node:test 测试（dist/test/）
```

## 使用

```sh
# 扫描并输出规范化清单（--save-cache 保存含证据的完整清单供下次复用）
node dist/src/cli.js scan <dir> --save-cache cache.json --out manifest.json

# 使用缓存复扫（仅证据一致的条目复用哈希）
node dist/src/cli.js scan <dir> --cache cache.json

# 比较两份清单（相等退出码 0，不同退出码 1 并打印差异）
node dist/src/cli.js diff manifest-a.json manifest-b.json

# 受控修改核验：重新扫描并与基线清单比对，不匹配退出码 1
node dist/src/cli.js verify <dir> --against manifest.json
```

## 清单格式（规范化输出）

```json
{
  "version": 1,
  "entries": [
    { "path": "a.txt", "type": "file", "hash": "<sha256>", "evidence": { "size": 5, "mtimeMs": 0, "ctimeMs": 0, "ino": 0 } },
    { "path": "sub", "type": "directory" },
    { "path": "link", "type": "symlink", "linkTarget": "a.txt" }
  ]
}
```

## 测试覆盖（`test/`）

- `scan.test.ts`：相对路径/类型/哈希、符号链接不跟随、序列化确定性。
- `cache.test.ts`：证据一致才复用（以 chmod 000 证明未重读）；同尺寸改写 +
  恢复 mtime、追加、增删文件等受控修改均被检出，不报伪相等。
- `stability.test.ts`：重试预算耗尽后标记 unstable（注入式单测 + 真实并发
  追加的集成测试）。
- `compare.test.ts`：added/removed/changed、顺序与元数据无关的相等性。
- `cli.test.ts`：scan/diff/verify 进程内端到端退出码与输出（沙箱禁止派生
  子进程，故直接调用 `main()`）。
