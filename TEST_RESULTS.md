# go test ./... 实际结果

```
?   	rxmatch/cmd/rxmatch	[no test files]
ok  	rxmatch/regex	0.153s
```

- 命令: `go test ./... -count=1`（-count=1 禁用缓存，强制真实重跑）
- 日期: 2026-10-05 01:49:46 CST
- Go 版本: go version go1.27.1 linux/amd64
- 环境说明: 默认 GOCACHE 目录只读，测试时使用了 GOCACHE=/tmp/gocache
