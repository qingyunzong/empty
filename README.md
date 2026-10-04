# cnc-pack

离线数控（G 代码）程序包库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 功能

- 将 G 代码程序切分为带序号的块，每块附带 CRC32 校验。
- 索引（`index.json`）记录程序名、块范围（`start`/`end`）与入口偏移（`entry`）；块内允许 `M98 P<name>` 子程序调用、`M99` 返回与 `GOTO N<label>` 分支。
- 解码器增量维护调用栈，按到达的块持续推进执行：
  - 嵌套深度超过 `--max-depth` → `E_DEPTH`
  - 子程序或跳转标号缺失 → `E_TARGET`
  - 块 CRC 校验失败 → `E_CRC`
- 重复重传的块按序号幂等去重，不会重复执行。
- 续传时返回已确认前缀（`CONFIRMED`）与下一所需序号（`NEXT`），已确认块不重复执行。
- 持久化：数据块先写临时文件再 rename，索引临时文件最后 rename（提交点）；rename 前崩溃留下的未索引尾部在读取时被忽略。

## CLI

```sh
node src/cli.js encode <outdir> [--main <name>] [--block-lines <n>] <file.nc...>
node src/cli.js verify <pkgdir>
node src/cli.js decode <pkgdir> [--from <seq>] [--max-depth <n>]
```

退出码：`0` 成功；`2` 缺块；`3` `E_CRC`；`4` `E_DEPTH`；`5` `E_TARGET`；`1` 其他错误。

## 库

- `src/crc32.js` — CRC32（IEEE）。
- `src/codec.js` — 块编码/解析、索引生成、原子持久化（`writePackage`/`readPackage`）。
- `src/decoder.js` — `Decoder`：`addBlock(seq, crc, payload)` 校验并去重，`run()` 推进执行，`status()` 返回 `{ done, confirmed, nextSeq, trace }`。
- `src/cli.js` — CLI，导出 `runCli(argv, io)` 返回退出码（便于进程内测试）。

## 测试

```sh
node --test
```
