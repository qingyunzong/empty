

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：9632c7df06979124cee7b83fcdde48790f9557f2

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tjsonnum\t1.120s\nok  \tjsonnum/cumround\t6.636s\nok  \tjsonnum/decimal\t3.872s\n"

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go build -o '{support}/jsonnum' .

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go build -o '{support}/withdraw_probe' '{support}/withdraw_probe.go'

A 检查：CLI 撤回入口
复现命令：python3 '{support}/cli_probe.py' '{support}/jsonnum'

A 检查：撤回末行的前缀重算
复现命令：'{support}/withdraw_probe'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 cli_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Run the real CLI with the withdrawal option offered by the compared flow.\"\"\"\nimport subprocess\nimport sys\n\nproc = subprocess.run(\n    [sys.argv[1], \"-mode\", \"cumulative\", \"-withdraw\", \"1\"],\n    input=b\"[0.5,0.5,0.5]\\n\",\n    stdout=subprocess.PIPE,\n    stderr=subprocess.PIPE,\n    check=False,\n)\nsys.stdout.buffer.write(proc.stdout)\nsys.stderr.buffer.write(proc.stderr)\nprint(f\"process exit code: {proc.returncode}\")\nraise SystemExit(proc.returncode)\n"

A 探针完整输入文件 withdraw_probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"math/big\"\n\t\"time\"\n\n\t\"jsonnum/cumround\"\n)\n\nfunc main() {\n\tfor _, n := range []int{2000, 8000} {\n\t\tamounts := make([]*big.Rat, n)\n\t\tfor i := range amounts {\n\t\t\tamounts[i] = big.NewRat(1, 3)\n\t\t}\n\t\tdeltas := cumround.Deltas(amounts, 2)\n\t\tconst repeats = 8\n\t\tstart := time.Now()\n\t\tfor i := 0; i < repeats; i++ {\n\t\t\tremaining, next := cumround.Withdraw(amounts, deltas, 2, n-1)\n\t\t\tif len(remaining) != n-1 || len(next) != n-1 {\n\t\t\t\tpanic(\"withdraw returned an unexpected result length\")\n\t\t\t}\n\t\t}\n\t\tfmt.Printf(\"withdraw at last row (%d calls): rows=%d elapsed=%s\\n\", repeats, n, time.Since(start))\n\t}\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-A/demonstration/cli_probe.py /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-A/demonstration/jsonnum\nprocess exit code: 2\nflag provided but not defined: -withdraw\nUsage of jsonnum:\n  -mode string\n    \tconvert: per-number rounding; cumulative: column cumulative-rounding deltas (default \"convert\")\n  -scale int\n    \tdecimal places of the output integers (default 2)\n$ /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-A/demonstration/withdraw_probe\nwithdraw at last row (8 calls): rows=2000 elapsed=16.907455ms\nwithdraw at last row (8 calls): rows=8000 elapsed=81.83817ms\n"

B 产物提交：063d29cf86cebc19a53e486422403f1822d2d9ab

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tjsonround\t32.116s\n"

B 预热命令：env 'GOCACHE={support}/gocache' /usr/local/go/bin/go build -o '{support}/jsonround' .

B 检查：CLI 撤回并重算累计差量
复现命令：env 'GOCACHE={support}/gocache' python3 '{support}/probe.py' '{support}/jsonround' withdraw

B 检查：精确十进制舍入与大整数输出
复现命令：env 'GOCACHE={support}/gocache' python3 '{support}/probe.py' '{support}/jsonround' exact
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport json\nimport subprocess\nimport sys\n\n\ndef run(binary, args, payload, expected):\n    p = subprocess.run(\n        [binary, *args], input=payload, text=True,\n        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,\n    )\n    out = p.stdout.strip()\n    if p.returncode != 0:\n        raise SystemExit(f\"CLI exit={p.returncode}; stderr={p.stderr.strip()}\")\n    try:\n        actual = json.loads(out)\n    except json.JSONDecodeError as exc:\n        raise SystemExit(f\"CLI emitted invalid JSON: {exc}; output={out!r}\")\n    if actual != expected:\n        raise SystemExit(f\"unexpected CLI result: {out}; expected={expected}\")\n    # Also verify the encoding retained integer JSON tokens rather than strings.\n    if any(isinstance(value, str) for value in actual):\n        raise SystemExit(f\"integer results were quoted: {out}\")\n    print(f\"exit={p.returncode} output={out}\")\n    if len(actual) <= 4:\n        print(f\"verified values={actual}\")\n    else:\n        print(f\"verified count={len(actual)} first={actual[0]} last={actual[-1]}\")\n\n\nif len(sys.argv) != 3:\n    raise SystemExit(\"usage: probe.py BINARY withdraw|exact\")\n\nbinary, case = sys.argv[1:]\nif case == \"withdraw\":\n    run(binary, [\"-scale\", \"0\", \"-cumul\", \"-withdraw\", \"1\"],\n        '[0.5,0.5,0.5]\\n', [0, 1])\nelif case == \"exact\":\n    run(binary, [\"-scale\", \"0\"],\n        '[123456789012345678901234567890,2.5,3.5,-0]\\n',\n        [123456789012345678901234567890, 2, 4, 0])\nelse:\n    raise SystemExit(f\"unknown case: {case}\")\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/gocache python3 /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/jsonround withdraw\nexit=0 output=[0,1]\nverified values=[0, 1]\n$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/gocache python3 /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/be07ea991dc940a39c0b275112f30322/judge/pair/attempt-001/demonstration-B/demonstration/jsonround exact\nexit=0 output=[123456789012345678901234567890,2,4,0]\nverified values=[123456789012345678901234567890, 2, 4, 0]\n"
