

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：633b197bea38259d1e49e0457b0b231fe4a7c952

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \ttsfill\t1.594s\n"

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/bin/go build -o '{support}/probe' '{support}/probe.go'

A 检查：逐步核对完整视图
复现命令：'{support}/probe' full

A 检查：检查缺口边界与精确插值
复现命令：'{support}/probe' boundary

A 检查：核对样本更新差量
复现命令：'{support}/probe' delta

A 检查：检查仓库内说明文件
复现命令：python3 '{support}/docs_probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 docs_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："import pathlib\nimport sys\n\nroot = pathlib.Path(sys.argv[1])\nreadmes = [p.name for p in root.iterdir() if p.is_file() and p.name.lower().startswith(\"readme\")]\nif readmes:\n    print(\"FAIL: README present:\", \", \".join(sorted(readmes)))\n    sys.exit(1)\nprint(\"PASS: workspace root has no README file\")\n"

A 探针完整输入文件 probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"math/big\"\n\t\"os\"\n\t\"tsfill\"\n)\n\nfunc rat(n, d int64) *big.Rat { return big.NewRat(n, d) }\n\nfunc same(a, b []tsfill.Point) bool {\n\tif len(a) != len(b) { return false }\n\tfor i := range a {\n\t\tif a[i].Index != b[i].Index || a[i].Value.Cmp(b[i].Value) != 0 { return false }\n\t}\n\treturn true\n}\n\nfunc require(ok bool, msg string) {\n\tif !ok { fmt.Fprintln(os.Stderr, \"FAIL:\", msg); os.Exit(1) }\n}\n\nfunc full() {\n\ts := tsfill.New(2)\n\tsamples := map[int64]*big.Rat{}\n\tconsumer := map[int64]*big.Rat{}\n\tinputs := []struct{ i int64; v *big.Rat }{{0,rat(0,1)},{5,rat(10,1)},{2,rat(4,1)},{2,rat(6,1)}}\n\tfor step, in := range inputs {\n\t\td := s.Add(in.i, in.v)\n\t\tfor _, p := range d.Retracted {\n\t\t\told, ok := consumer[p.Index]\n\t\t\trequire(ok && old.Cmp(p.Value)==0, fmt.Sprintf(\"step %d: invalid retraction\",step+1))\n\t\t\tdelete(consumer,p.Index)\n\t\t}\n\t\tfor _, p := range d.Added { consumer[p.Index] = new(big.Rat).Set(p.Value) }\n\t\tsamples[in.i] = in.v\n\t\twant := tsfill.Fill(samples,2)\n\t\trequire(same(s.Emitted(),want),fmt.Sprintf(\"step %d: Emitted differs from Fill\",step+1))\n\t\trequire(len(consumer)==len(want),fmt.Sprintf(\"step %d: consumer length differs\",step+1))\n\t\tfor _, p := range want {\n\t\t\tv,ok := consumer[p.Index]\n\t\t\trequire(ok && v.Cmp(p.Value)==0,fmt.Sprintf(\"step %d: consumer point %d differs\",step+1,p.Index))\n\t\t}\n\t\tfor i,v := range samples {\n\t\t\tgot,ok := consumer[i]\n\t\t\trequire(ok && got.Cmp(v)==0,fmt.Sprintf(\"step %d: observed sample %d missing\",step+1,i))\n\t\t}\n\t}\n\tfmt.Printf(\"PASS: 4 updates; consumer, Emitted and Fill match, including %d observed samples\\n\",len(samples))\n}\n\nfunc boundary() {\n\tx := map[int64]*big.Rat{0:rat(0,1),4:rat(8,1)}\n\ta := tsfill.Fill(x,2)\n\trequire(same(a,[]tsfill.Point{{0,rat(0,1)},{4,rat(8,1)}}),\"gap length 3 should exceed m=2\")\n\tb := tsfill.Fill(x,3)\n\trequire(same(b,[]tsfill.Point{{0,rat(0,1)},{1,rat(2,1)},{2,rat(4,1)},{3,rat(6,1)},{4,rat(8,1)}}),\"gap length 3 should equal m=3\")\n\tc := tsfill.Fill(map[int64]*big.Rat{0:rat(1,3),2:rat(1,2)},1)\n\trequire(same(c,[]tsfill.Point{{0,rat(1,3)},{1,rat(5,12)},{2,rat(1,2)}}),\"rational interpolation or endpoint range wrong\")\n\tfmt.Println(\"PASS: gap 3 omitted at m=2, filled at m=3; 1/3..1/2 yields 5/12; no exterior points\")\n}\n\nfunc delta() {\n\ts := tsfill.New(2)\n\ts.Add(0,rat(0,1)); s.Add(2,rat(4,1)); s.Add(4,rat(8,1))\n\td := s.Add(2,rat(10,1))\n\twantOld := []tsfill.Point{{1,rat(2,1)},{2,rat(4,1)},{3,rat(6,1)}}\n\twantNew := []tsfill.Point{{1,rat(5,1)},{2,rat(10,1)},{3,rat(9,1)}}\n\trequire(same(d.Retracted,wantOld),\"incorrect retractions\")\n\trequire(same(d.Added,wantNew),\"incorrect additions\")\n\trequire(same(s.Emitted(),[]tsfill.Point{{0,rat(0,1)},{1,rat(5,1)},{2,rat(10,1)},{3,rat(9,1)},{4,rat(8,1)}}),\"post-update view wrong\")\n\tfmt.Println(\"PASS: update at 2 retracts 1=2,2=4,3=6; adds 1=5,2=10,3=9\")\n}\n\nfunc main() {\n\tif len(os.Args)!=2 { fmt.Fprintln(os.Stderr,\"usage: probe full|boundary|delta\"); os.Exit(2) }\n\tswitch os.Args[1] {\n\tcase \"full\": full()\n\tcase \"boundary\": boundary()\n\tcase \"delta\": delta()\n\tdefault: fmt.Fprintln(os.Stderr,\"unknown case\"); os.Exit(2)\n\t}\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-A/demonstration/probe full\nPASS: 4 updates; consumer, Emitted and Fill match, including 3 observed samples\n$ /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-A/demonstration/probe boundary\nPASS: gap 3 omitted at m=2, filled at m=3; 1/3..1/2 yields 5/12; no exterior points\n$ /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-A/demonstration/probe delta\nPASS: update at 2 retracts 1=2,2=4,3=6; adds 1=5,2=10,3=9\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-A/demonstration/docs_probe.py /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/record/A/attempt-001/workspace\nPASS: workspace root has no README file\n"

B 产物提交：f9afd847f36b409303565364f58c66fc6797cde9

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \ttsfill\t2.054s\n"

B 预热命令：/usr/bin/env 'GOCACHE={support}/.gocache' /usr/local/bin/go run '{support}/probe_full_view.go'

B 检查：核对完整序列范围
复现命令：/usr/bin/env 'GOCACHE={support}/.gocache' /usr/local/bin/go run '{support}/probe_full_view.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe_full_view.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"math/big\"\n\t\"os\"\n\n\t\"tsfill\"\n)\n\nfunc format(points []tsfill.Point) string {\n\tout := \"[\"\n\tfor i, p := range points {\n\t\tif i > 0 {\n\t\t\tout += \" \"\n\t\t}\n\t\tout += fmt.Sprintf(\"%d:%s\", p.T, p.V.RatString())\n\t}\n\treturn out + \"]\"\n}\n\nfunc check(points []tsfill.Point) bool {\n\tif len(points) != 2 {\n\t\treturn false\n\t}\n\treturn points[0].T == 1 && points[0].V.Cmp(big.NewRat(2, 1)) == 0 &&\n\t\tpoints[1].T == 2 && points[1].V.Cmp(big.NewRat(4, 1)) == 0\n}\n\nfunc main() {\n\tsamples := map[int64]*big.Rat{0: big.NewRat(0, 1), 3: big.NewRat(6, 1)}\n\ts := tsfill.New(2)\n\ts.Add(0, samples[0])\n\tdelta := s.Add(3, samples[3])\n\tbatch, incremental := tsfill.FillAll(samples, 2), s.Fills()\n\tfmt.Printf(\"FillAll=%s\\n\", format(batch))\n\tfmt.Printf(\"Fills=%s\\n\", format(incremental))\n\tfmt.Printf(\"Delta.Added=%s\\n\", format(delta.Added))\n\tif !check(batch) || !check(incremental) || !check(delta.Added) || len(delta.Retracted) != 0 {\n\t\tfmt.Fprintln(os.Stderr, \"probe failed: unexpected product behavior\")\n\t\tos.Exit(1)\n\t}\n\tfor _, points := range [][]tsfill.Point{batch, incremental, delta.Added} {\n\t\tfor _, p := range points {\n\t\t\tif _, observed := samples[p.T]; observed {\n\t\t\t\tfmt.Fprintln(os.Stderr, \"probe failed: observed sample was returned\")\n\t\t\t\tos.Exit(1)\n\t\t\t}\n\t\t}\n\t}\n\tfmt.Printf(\"observed samples in each result=0/%d; complete view requires %d points\\n\", len(samples), len(samples)+len(batch))\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-B/demonstration/.gocache /usr/local/bin/go run /home/delin/.local/share/gsb-workbench/artifacts/4aafb8c3257a419ab73b7be3dbf51551/judge/pair/attempt-002/demonstration-B/demonstration/probe_full_view.go\nFillAll=[1:2 2:4]\nFills=[1:2 2:4]\nDelta.Added=[1:2 2:4]\nobserved samples in each result=0/2; complete view requires 4 points\n"
