# permset

权限文本解析库：对 64 位整数闭区间集合求值，输出规范化的不相交闭区间。
仅使用 Go 标准库。

## 表达式语法

```
expr    := diff  ('|' diff)*        // 并
diff    := inter ('-' inter)*       // 差（左结合）
inter   := primary ('&' primary)*   // 交（优先级最高）
primary := '(' expr ')' | interval | name
interval:= '[' endpoint [',' endpoint] ']'
endpoint:= ['-'] 数字 | 'min' | 'max'   // min/max 为 int64 极值
```

- 语法错误返回 `*permset.Error`，含字节偏移位置 `Pos`。
- 区间 `[x]` 是单点 `[x,x]` 的简写；`lo > hi` 报错。

## 核心 API

- `permset.Eval(src)`：无命名引用的表达式求值，返回规范 `Set`。
- `Norm / Set.Union / Intersect / Diff / Contains / Equal`：区间集运算。
  相邻合并与差集端点删去均对 `math.MaxInt64`/`math.MinInt64` 做了溢出防护。
- `env := permset.NewEnv()`：命名集合环境。
  - `env.Define(name, expr)`：版本化定义；未定义引用返回 `*UndefinedError`；
    循环引用拒绝并返回 `*CycleError`（含最短引用链 `Chain`）。
    定义更正只重算依赖闭包（返回受影响名列表），旧版本快照保留于
    `env.Snapshot(name, version)` / `env.Versions(name)`。
  - `env.Eval(src)`：返回 `WSet`，每个结果段带来源表达式见证 `Sources`。
  - `env.Verify()`：按拓扑序完整重算所有定义并与缓存值核对。

## 测试

见 `TESTING.md`。
