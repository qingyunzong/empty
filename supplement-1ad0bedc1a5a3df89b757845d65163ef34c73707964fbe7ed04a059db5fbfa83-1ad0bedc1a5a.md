

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：abddf8c8444046e22898bc252bf9c77506555d13

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tgraphlib/graph\t1.351s\nok  \tgraphlib/verify\t1.059s\n"

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/bin/go run '{support}/A-id-collision-probe.go'

A 检查：同名顶点的覆盖核对
复现命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/bin/go run '{support}/A-id-collision-probe.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 A-id-collision-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n    \"fmt\"\n    \"os\"\n    \"graphlib/graph\"\n    \"graphlib/verify\"\n)\n\nfunc main() {\n    g := graph.New()\n    g.AddEdge(\"x\", \"y\")\n    g.AddEdge(\"z\", \"x\")\n    a := g.Analyze()\n    edges := []verify.Edge{{L:\"x\", R:\"y\"}, {L:\"z\", R:\"x\"}}\n    vertices := append(g.Vertices(graph.Left), g.Vertices(graph.Right)...)\n    c, n, err := verify.MinVertexCover(vertices, edges)\n    fmt.Printf(\"version=%d left=%v right=%v matching=%v cover=%v\\n\", g.Version(), g.Vertices(graph.Left), g.Vertices(graph.Right), a.Matching, a.Cover)\n    fmt.Printf(\"enumerated_cover=%v size=%d err=%v\\n\", c, n, err)\n    singleLabelErr := verify.CheckCover(edges, []string{\"x\"})\n    fmt.Printf(\"single_label_cover_check=%v\\n\", singleLabelErr)\n    fmt.Printf(\"summary: matching_size=%d analyzed_cover_size=%d enumerated_size=%d single_label_accepted=%t\\n\", len(a.Matching), len(a.Cover), n, singleLabelErr == nil)\n    if len(a.Matching) != 2 || len(a.Cover) != 2 || n != 1 || err != nil || singleLabelErr != nil ||\n        len(g.Vertices(graph.Left)) != 2 || len(g.Vertices(graph.Right)) != 2 {\n        fmt.Fprintln(os.Stderr, \"probe failed: expected ID collision was not reproduced\")\n        os.Exit(1)\n    }\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-002/demonstration-A/demonstration/gocache /usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-002/demonstration-A/demonstration/A-id-collision-probe.go\nversion=2 left=[x z] right=[x y] matching=[{x y} {z x}] cover=[x z]\nenumerated_cover=[x] size=1 err=<nil>\nsingle_label_cover_check=<nil>\nsummary: matching_size=2 analyzed_cover_size=2 enumerated_size=1 single_label_accepted=true\n"

B 产物提交：258ebf51d5c1024e0b564068371893399e28dc1d

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tgraphlib/graph\t1.028s\nok  \tgraphlib/verify\t1.705s\n"

B 预热命令：/usr/bin/env 'GOCACHE={support}/.gocache' /usr/local/bin/go run '{support}/cache_alias_probe.go'

B 检查：同版本分析结果受调用方改动影响
复现命令：/usr/bin/env 'GOCACHE={support}/.gocache' /usr/local/bin/go run '{support}/cache_alias_probe.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 cache_alias_probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\t\"strings\"\n\n\t\"graphlib/graph\"\n\t\"graphlib/verify\"\n)\n\nfunc fail(format string, args ...any) {\n\tfmt.Fprintf(os.Stderr, \"probe failed: \"+format+\"\\n\", args...)\n\tos.Exit(1)\n}\n\nfunc main() {\n\tg := graph.New()\n\tfor _, e := range []graph.Edge{{U: \"a\", V: \"x\"}, {U: \"b\", V: \"y\"}} {\n\t\tif _, err := g.AddEdge(e.U, e.V); err != nil {\n\t\t\tfail(\"add edge: %v\", err)\n\t\t}\n\t}\n\tfirst := g.Analyze()\n\tif err := verify.Analysis(g, first); err != nil {\n\t\tfail(\"initial analysis: %v\", err)\n\t}\n\tif len(first.Matching) != 2 {\n\t\tfail(\"initial matching size=%d, want 2\", len(first.Matching))\n\t}\n\tversion := g.Version()\n\tfirst.Matching[0] = graph.Edge{U: \"a\", V: \"y\"}\n\tsecond := g.Analyze()\n\tif g.Version() != version || second.Version != version {\n\t\tfail(\"version changed after caller edit: graph=%d analysis=%d\", g.Version(), second.Version)\n\t}\n\tif len(second.Matching) == 0 || g.Has(second.Matching[0].U, second.Matching[0].V) {\n\t\tfail(\"cached matching did not contain the caller's invalid edge: %v\", second.Matching)\n\t}\n\terr := verify.Analysis(g, second)\n\tif err == nil || !strings.Contains(err.Error(), \"not in graph\") {\n\t\tfail(\"verification error=%v, want missing matching edge\", err)\n\t}\n\tfmt.Printf(\"初次校验通过：版本=%d，匹配数=%d\\n\", version, len(first.Matching))\n\tfmt.Printf(\"再次分析：版本=%d，匹配=%v\\n\", second.Version, second.Matching)\n\tfmt.Printf(\"验证器实际报错：%v\\n\", err)\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-002/demonstration-B/demonstration/.gocache /usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-002/demonstration-B/demonstration/cache_alias_probe.go\n初次校验通过：版本=2，匹配数=2\n再次分析：版本=2，匹配=[{a y} {b y}]\n验证器实际报错：verify: matched edge {a,y} not in graph\n"

补充探针完整输入文件 A-id-collision-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n    \"fmt\"\n    \"graphlib/graph\"\n    \"graphlib/verify\"\n)\n\nfunc main() {\n    g := graph.New()\n    g.AddEdge(\"x\", \"y\")\n    g.AddEdge(\"z\", \"x\")\n    a := g.Analyze()\n    edges := []verify.Edge{{L:\"x\", R:\"y\"}, {L:\"z\", R:\"x\"}}\n    vertices := append(g.Vertices(graph.Left), g.Vertices(graph.Right)...)\n    c, n, err := verify.MinVertexCover(vertices, edges)\n    fmt.Printf(\"version=%d left=%v right=%v matching=%v cover=%v\\n\", g.Version(), g.Vertices(graph.Left), g.Vertices(graph.Right), a.Matching, a.Cover)\n    fmt.Printf(\"enumerated_cover=%v size=%d err=%v\\n\", c, n, err)\n    fmt.Printf(\"single_label_cover_check=%v\\n\", verify.CheckCover(edges, []string{\"x\"}))\n}\n"

补充输出 A-probe-initial.log以 JSON 字符串记录，解码后可还原完整原始输出："source_sha=abddf8c8444046e22898bc252bf9c77506555d13\ncwd=/tmp/gsb-A-probe-3\nGOCACHE=/tmp/gsb-go-cache\ncommand=/usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-001/evidence/A-id-collision-probe.go\nexitCode=1\n# command-line-arguments\n/home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-001/evidence/A-id-collision-probe.go:19:86: syntax error: unexpected ) in composite literal; possibly missing comma or }\n"

补充输出 A-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："source_sha=abddf8c8444046e22898bc252bf9c77506555d13\ncwd=/tmp/gsb-A-probe-final-3\nGOCACHE=/tmp/gsb-go-cache\ncommand=/usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-001/evidence/A-id-collision-probe.go\nexitCode=0\nversion=2 left=[x z] right=[x y] matching=[{x y} {z x}] cover=[x z]\nenumerated_cover=[x] size=1 err=<nil>\nsingle_label_cover_check=<nil>\n"

补充探针完整输入文件 B-cache-alias-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n    \"fmt\"\n    \"graphlib/graph\"\n    \"graphlib/verify\"\n)\n\nfunc main() {\n    g := graph.New()\n    g.AddEdge(\"a\", \"x\")\n    g.AddEdge(\"b\", \"y\")\n    first := g.Analyze()\n    fmt.Printf(\"before version=%d matching=%v cover=%v check=%v\\n\", first.Version, first.Matching, first.Cover, verify.Analysis(g, first))\n    first.Matching[0] = graph.Edge{U:\"a\", V:\"y\"}\n    second := g.Analyze()\n    fmt.Printf(\"after version=%d matching=%v cover=%v check=%v\\n\", second.Version, second.Matching, second.Cover, verify.Analysis(g, second))\n}\n"

补充输出 B-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："source_sha=258ebf51d5c1024e0b564068371893399e28dc1d\ncwd=/tmp/gsb-B-probe-3\nGOCACHE=/tmp/gsb-go-cache\ncommand=/usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/d249ff0ca1fc4f5a9423eaee2f9bbe8c/judge/pair/attempt-001/evidence/B-cache-alias-probe.go\nexitCode=0\nbefore version=2 matching=[{a x} {b y}] cover=[a b] check=<nil>\nafter version=2 matching=[{a y} {b y}] cover=[a b] check=verify: matched edge {a,y} not in graph\n"
