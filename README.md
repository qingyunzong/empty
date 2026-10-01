# minivcs

纯 Python 3.11 标准库实现的迷你版本控制系统。提交对象为内容寻址的
`{parents, message, tree}`（tree 为路径到文本的映射），存储于 `.minivcs/`。

## CLI

```sh
python3 minivcs.py [--repo DIR] init
python3 minivcs.py commit --branch B -m MSG [--set P=V]... [--del P]... [--parent H]...
python3 minivcs.py rebase --branch F --onto M [--fail-before-ref K]
python3 minivcs.py resolve [--set P=V]... [--del P]...
python3 minivcs.py continue
python3 minivcs.py abort
```

退出码：0 成功，1 冲突，2 错误。

## Rebase 语义

1. 枚举两端祖先集求唯一最低公共祖先（LCA）；无公共祖先时以空树为基。
2. 按拓扑顺序（父先于子）重放 F 独有提交，每步对路径做三方合并
   （base = 被重放提交第一父提交的树，ours = 当前新顶端，theirs = 被重放提交的树）。
3. 仅一方相对基变更则采纳；双方异值或修改/删除冲突即停止，状态
   （已重放提交、当前提交、冲突路径、剩余队列）保存到 `.minivcs/rebase_state.json`。
4. `resolve --set p=v`（或 `--del p`）记录解决方案后 `continue` 完成剩余重放；
   `abort` 恢复原分支引用并删除状态。
5. 测试钩子 `--fail-before-ref K`：第 K 个重放提交落库并保存状态后、
   写分支引用前以退出码 2 模拟崩溃；`continue` 依据状态续放，不会重复提交。

## 测试

```sh
python3 -m unittest -v
```

真实运行结果见 `TEST_RESULTS.txt`。
