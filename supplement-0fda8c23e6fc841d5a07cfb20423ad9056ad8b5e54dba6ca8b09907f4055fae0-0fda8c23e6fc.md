

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：e5a574e925a44a72e6aef4a61b92882779526f3f

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："?   \tfiresim\t[no test files]\n"

A 检查：核对模拟核心是否交付
复现命令：python3 '{support}/probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Inspect the Go package declarations in the supplied artifact workspace.\"\"\"\n\nimport pathlib\nimport re\nimport sys\n\n\nroot = pathlib.Path(sys.argv[1])\ngo_files = sorted(root.glob(\"*.go\"))\ndecls = []\nfor path in go_files:\n    source = path.read_text(encoding=\"utf-8\")\n    for kind, name in re.findall(\n        r\"(?m)^\\s*(func|type|var|const)\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_]\\w*)\", source\n    ):\n        decls.append(f\"{kind} {name}\")\n\nprint(\"Go files:\", \", \".join(path.name for path in go_files) or \"none\")\nprint(\"Package declarations:\", \", \".join(decls) or \"none\")\nif len(decls) == 1 and decls[0] == \"func nextRand\":\n    print(\"Grid/state, propagation, wind, event, checkpoint APIs: absent\")\n    print(\"Observed package provides only the PRNG function.\")\n    sys.exit(1)\n\nprint(\"Expected minimal artifact shape was not observed.\")\nsys.exit(2)\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/judge/pair/attempt-002/demonstration-A/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/record/A/attempt-001/workspace\nGo files: rng.go\nPackage declarations: func nextRand\nGrid/state, propagation, wind, event, checkpoint APIs: absent\nObserved package provides only the PRNG function.\n"

B 产物提交：c1a5dac8483df375d595238166e9bb4aa4f68e26

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tfiresim\t1.050s\n"

B 预热命令：env 'GOCACHE={support}/gocache' /usr/local/bin/go -C '{workspace}' test -race -run '^$' ./...

B 检查：NewSim 输入边界校验
复现命令：python3 '{support}/probe.py' '{workspace}'

B 检查：灭火、风段与断点续跑
复现命令：env 'GOCACHE={support}/gocache' /usr/local/bin/go -C '{workspace}' test -race -count=1 -run '^(TestExtinguishBeforePropagation|TestWindSegments|TestSegmentedRunMatchesSingleRun)$' -v .
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Report validation guards actually present in firesim.NewSim.\"\"\"\nimport pathlib\nimport re\nimport sys\n\n\nsource_path = pathlib.Path(sys.argv[1]) / \"firesim.go\"\nsource = source_path.read_text(encoding=\"utf-8\")\nmatch = re.search(r\"func NewSim\\(cfg Config\\) \\*Sim \\{\", source)\nif not match:\n    raise SystemExit(\"NewSim definition not found\")\n\nstart = match.start()\ndepth = 0\nend = None\nfor index in range(source.index(\"{\", start), len(source)):\n    if source[index] == \"{\":\n        depth += 1\n    elif source[index] == \"}\":\n        depth -= 1\n        if depth == 0:\n            end = index + 1\n            break\nif end is None:\n    raise SystemExit(\"NewSim function body is incomplete\")\n\nbody = source[start:end]\nchecks = {\n    \"Width\": re.search(r\"cfg\\.Width\\s*(?:<=|<|==|!=|>=|>)\", body),\n    \"Height\": re.search(r\"cfg\\.Height\\s*(?:<=|<|==|!=|>=|>)\", body),\n    \"BaseProb range\": re.search(r\"cfg\\.BaseProb\\s*(?:<|>)\", body),\n    \"WindBoost range\": re.search(r\"cfg\\.WindBoost\\s*(?:<|>)\", body),\n}\nlines = source[:start].count(\"\\n\") + 1\nprint(f\"firesim.go:{lines}: {source[start:source.find(chr(10), start)]}\")\nfor label, check in checks.items():\n    print(f\"{label} 校验: {'存在' if check else '未发现'}\")\nif not any(checks.values()):\n    print(\"结论：源码未校验宽高及概率范围；仅确认边界风险，未复现故障。\")\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/judge/pair/attempt-002/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/record/B/attempt-001/workspace\nfiresim.go:137: func NewSim(cfg Config) *Sim {\nWidth 校验: 未发现\nHeight 校验: 未发现\nBaseProb range 校验: 未发现\nWindBoost range 校验: 未发现\n结论：源码未校验宽高及概率范围；仅确认边界风险，未复现故障。\n$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/judge/pair/attempt-002/demonstration-B/demonstration/gocache /usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b211f95e4a1e4261aa83866ba3e4ef1c/record/B/attempt-001/workspace test -race -count=1 -run '^(TestExtinguishBeforePropagation|TestWindSegments|TestSegmentedRunMatchesSingleRun)$' -v .\n=== RUN   TestExtinguishBeforePropagation\n--- PASS: TestExtinguishBeforePropagation (0.00s)\n=== RUN   TestWindSegments\n--- PASS: TestWindSegments (0.00s)\n=== RUN   TestSegmentedRunMatchesSingleRun\n--- PASS: TestSegmentedRunMatchesSingleRun (0.01s)\nPASS\nok  \tfiresim\t1.150s\n"
