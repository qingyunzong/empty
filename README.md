# logparse

`key=value` 日志行解析库。

## 语义

- `key=value`：普通键值对；`key=` 为空串；裸 `key` 为布尔 `true`。
- 值可加双引号，引号内/裸值中支持转义：`\ `、`\"`、`\\`、`\=`、`\n`、`\t`。
- 相同键保留全部值，按出现顺序（`Line.Values()` 按规范键聚合）。
- 坏转义/坏行（非法转义、未闭合引号、空键等）只隔离本物理行：
  `Line.Bad=true`，`Line.Raw` 输出原始跨度，`Line.Offset` 为流内字节偏移。
- 键别名构成有向映射（`NewConfig`），链式解析到最终规范键，环（含自环）拒绝；
  去重/聚合基于最终规范键。
- `Stream` 支持任意切块喂入；`SetConfig` 热更新只对切换后开始的行生效，
  跨块未完成的旧行仍用旧规则。

## 用法

```go
cfg, _ := logparse.NewConfig(map[string]string{"lvl": "level"})
s := logparse.NewStream(cfg)
lines := s.Feed([]byte("lvl=info msg=\"hi there\" verbose\n"))
s.SetConfig(newCfg) // 只影响之后开始的行
lines = append(lines, s.Close()...)
```

## 测试

```sh
go test ./...
```
