# RESULTS

环境: Node.js v22.22.1,仅标准库,node:test,离线单机。以下全部为真实运行输出。

## 1. node --test(15/15 通过)

```
ok 1 - 1. inherited clearance makes aggregate visible; build+verify pass
ok 2 - 1b. explicit allow grant is inherited through the role DAG
ok 3 - 2. one denied source fails build with minimal over-authority set
ok 4 - 2b. deny wins over allow on conflict
ok 5 - 3. mask version mismatch raises E_MASK
ok 6 - 3b. matching mask covers unreadable source and redacts the masked field
ok 7 - 4. revoking a mask does not retroactively fail issued reports but blocks new issuance
ok 8 - 5. closure computation matches brute-force enumeration on small graphs
ok 9 - tampered report fails verify with E_HASH
ok 10 - verify re-evaluates authorization from embedded snapshot
ok 11 - role inheritance cycle raises E_CYCLE
ok 12 - cli: build then verify succeeds (exit 0)
ok 13 - cli: unauthorized build exits 1 with E_AUTH on stderr
ok 14 - cli: invalid JSON input exits 1 with E_PARSE on stderr
ok 15 - cli: missing args prints usage to stderr and exits 1
```

测试运行器汇总:

```
# tests 1
# pass 1
# fail 0
```

## 2. CLI 端到端(真实 shell 调用)

### 验收1+脱敏覆盖:签发与验证通过(exit 0)

```
$ node cli.js build examples/spec.json report.json
built report.json unit=fin_summary_q3 role=analyst sources=3 hash=sha256:1edd7e5414b7f48cf41c5a62ba94998947a1810ac6b268b17b7124168a5f1aab
exit=0
$ node cli.js verify report.json
OK unit=fin_summary_q3 role=analyst sources=3 hash=sha256:1edd7e5414b7f48cf41c5a62ba94998947a1810ac6b268b17b7124168a5f1aab
exit=0
```

### 验收4:撤销脱敏 —— 旧报表 verify 仍通过,新签发失败

```
# masks 已从 spec 中移除(spec-revoked.json)
$ node cli.js verify report.json   # 旧报表,内嵌快照,不追溯
OK unit=fin_summary_q3 role=analyst sources=3 hash=sha256:1edd7e5414b7f48cf41c5a62ba94998947a1810ac6b268b17b7124168a5f1aab
exit=0
$ node cli.js build spec-revoked.json report2.json   # 新签发失败
E_AUTH: aggregate not visible: minimal over-authority set = [payroll_q3]
{
  "minimalSet": [
    "payroll_q3"
  ],
  "failures": [
    {
      "unit": "payroll_q3",
      "reason": "insufficient-clearance"
    }
  ]
}
exit=1
```

### 验收3:脱敏版本不匹配 -> E_MASK(exit 1,stderr)

```
$ node cli.js build spec-maskstale.json report3.json
E_MASK: aggregate not visible: minimal over-authority set = [payroll_q3]
{
  "minimalSet": [
    "payroll_q3"
  ],
  "failures": [
    {
      "unit": "payroll_q3",
      "reason": "mask-version-mismatch",
      "maskId": "mask-payroll-v3",
      "maskVersion": 2,
      "unitVersion": 3
    }
  ]
}
exit=1
```

### 错误处理:文件不存在 -> E_IO(exit 1,stderr)

```
$ node cli.js verify /nonexistent.json
E_IO: cannot read /nonexistent.json: ENOENT: no such file or directory, open '/nonexistent.json'
exit=1
```

## 3. 验收对照

| 验收项 | 测试 / 场景 | 结果 |
| --- | --- | --- |
| 1 继承可读汇总通过 | `1. inherited clearance...`、`1b. explicit allow grant is inherited`、CLI build+verify exit 0 | 通过 |
| 2 一个来源 deny 失败并列最小集合 | `2. one denied source fails build with minimal over-authority set`(minimalSet=["u_conf"])、`2b. deny wins over allow` | 通过 |
| 3 脱敏版本不匹配报 E_MASK | `3. mask version mismatch raises E_MASK`、CLI `spec-maskstale.json` exit 1 | 通过 |
| 4 撤销脱敏:旧报表 verify 通过、新签发失败 | `4. revoking a mask...`、CLI 撤销场景(old verify exit 0,new build exit 1 E_AUTH) | 通过 |
| 5 小图枚举闭包对照 | `5. closure computation matches brute-force enumeration`(200 随机角色 DAG + 200 随机汇总图,对照朴素不动点枚举) | 通过 |

补充保障:篡改检测 `E_HASH`、快照重估授权、继承环 `E_CYCLE`、非法 JSON `E_PARSE`、缺参 usage(exit 1)。

备注:沙箱禁止 Node 内 spawn 子进程,CLI 端到端测试通过 `require('../cli').run` 进程内调用完成(与真实进程共用同一入口);真实进程级调用结果见第 2 节 shell 输出。
