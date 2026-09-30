# rule_engine

小型正向规则引擎（Python 3.11 标准库，无第三方依赖）。

## 规则语法

```
head :- a, b, not c
```

- `head`、`a`、`b`、`c` 为原子（`name` 或 `name(arg1,arg2)`），未知谓词允许。
- `not c` 为负条件：仅在规则求值时刻 `c` 不在当前事实集中才满足。
- 同一事实可被多条规则证明；只有全部证明失效时该派生事实才被撤销。

## CLI

```bash
python -m rule_engine [--state PATH] assert <fact>
python -m rule_engine [--state PATH] retract <fact>
python -m rule_engine [--state PATH] rule "d:-a,not c"
python -m rule_engine [--state PATH] derive <fact>
python -m rule_engine [--state PATH] facts    # 列出全部事实及类别
python -m rule_engine [--state PATH] rules    # 列出全部规则
```

状态持久化在 JSON 文件中（默认 `./.rule_engine_state.json`，可用 `--state`
或环境变量 `RULE_ENGINE_STATE` 覆盖）。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（`derive`：事实成立） |
| 1 | `derive` 不成立；`retract` 非基础事实 |
| 2 | 规则/事实语法错误 |
| 6 | 试图 `assert` 一个派生事实 |

## 语义要点

- 事实分基础（assert）与派生（规则推出）两类，派生事实不得被 assert。
- 每轮推导按规则 id 升序评估，结果确定；规则循环允许，因原子宇宙有限
  必然收敛。
- 引擎为每个派生事实维护证明（support）列表与"事实 → 依赖它的规则"
  反向索引；任何变更后只保留证明仍然有效的派生，撤回基础事实因此只
  级联失效必要的派生，并可能因 `not` 条件变为满足而触发新推导。

## 测试

```bash
python -m unittest discover -s tests -v
```
