

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：c7a11c985b0e38062ac5e2ef91b18bb8a440a002

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/verify/A/attempt-001/workspace/vstore test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tvstore\t1.222s\n"

A 预热命令：python3 '{support}/warmup.py' '{workspace}'

A 检查：压缩后墓碑序号的冲突写入
复现命令：python3 '{support}/run_probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 A-tombstone-conflict-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"errors\"\n\t\"fmt\"\n\t\"os\"\n\n\t\"vstore\"\n)\n\nfunc main() {\n\ts := vstore.NewStore()\n\tif err := s.Put(\"k\", 1, []byte(\"old\")); err != nil {\n\t\tfail(\"initial Put\", err)\n\t}\n\tif err := s.Delete(\"k\", 2); err != nil {\n\t\tfail(\"Delete\", err)\n\t}\n\ts.Compact()\n\terr := s.Put(\"k\", 2, []byte(\"conflicting-value\"))\n\tfmt.Printf(\"after Compact, Put at tombstone seq=2: err=%v retained=%d\\n\", err, s.Len(\"k\"))\n\tif errors.Is(err, vstore.ErrConflict) {\n\t\tfmt.Println(\"conflict correctly rejected; defect not reproduced\")\n\t\tos.Exit(1)\n\t}\n\tif err != nil {\n\t\tfmt.Printf(\"unexpected error: %v\\n\", err)\n\t\tos.Exit(1)\n\t}\n\tfmt.Println(\"REPRODUCED: conflicting write accepted after Compact\")\n}\n\nfunc fail(step string, err error) {\n\tfmt.Printf(\"setup failed at %s: %v\\n\", step, err)\n\tos.Exit(2)\n}\n"

A 探针完整输入文件 run_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："import os\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nsupport = Path(__file__).resolve().parent\nworkspace = Path(sys.argv[1]).resolve()\nenv = os.environ.copy()\nenv[\"GOCACHE\"] = str(support / \"gocache\")\ncmd = [\n    \"/usr/local/go/bin/go\", \"-C\", str(workspace / \"vstore\"),\n    \"run\", str(support / \"A-tombstone-conflict-probe.go\"),\n]\ntry:\n    result = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE,\n                            stderr=subprocess.STDOUT, timeout=45)\nexcept subprocess.TimeoutExpired:\n    print(\"probe timed out\", flush=True)\n    sys.exit(124)\nprint(result.stdout, end=\"\")\nif result.returncode != 0:\n    sys.exit(result.returncode)\nif \"REPRODUCED: conflicting write accepted after Compact\" not in result.stdout:\n    print(\"probe assertion failed: expected behavior was not observed\")\n    sys.exit(1)\n"

A 探针完整输入文件 warmup.py以 JSON 字符串记录，解码后可还原完整输入文件："import os\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nsupport = Path(__file__).resolve().parent\nworkspace = Path(sys.argv[1]).resolve()\nenv = os.environ.copy()\nenv[\"GOCACHE\"] = str(support / \"gocache\")\nversion = subprocess.run([\"/usr/local/go/bin/go\", \"version\"], env=env,\n                         text=True, stdout=subprocess.PIPE,\n                         stderr=subprocess.STDOUT, timeout=10)\nprint(version.stdout, end=\"\")\nif version.returncode:\n    sys.exit(version.returncode)\nif \"go1.27.1\" not in version.stdout:\n    print(\"unexpected Go compiler version\")\n    sys.exit(1)\ncmd = [\"/usr/local/go/bin/go\", \"-C\", str(workspace / \"vstore\"),\n       \"test\", \"-run\", \"^$\", \"./...\"]\nresult = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE,\n                        stderr=subprocess.STDOUT, timeout=120)\nprint(result.stdout, end=\"\")\nsys.exit(result.returncode)\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/judge/pair/attempt-001/demonstration-A/demonstration/run_probe.py /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/record/A/attempt-001/workspace\nafter Compact, Put at tombstone seq=2: err=<nil> retained=1\nREPRODUCED: conflicting write accepted after Compact\n"

B 产物提交：56c3838345a9eaaa0a1da07c36752316a64ddbf4

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tversionedtable/vtable\t7.162s\n"

B 预热命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/stale_reader_probe.go'

B 预热命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/compacted_snapshot_probe.go'

B 检查：释放句柄与压缩
复现命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/stale_reader_probe.go'

B 检查：注册已回收快照
复现命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/compacted_snapshot_probe.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 compacted_snapshot_probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\n\t\"versionedtable/vtable\"\n)\n\nfunc main() {\n\ts := vtable.New()\n\tif err := s.Put(\"k\", 1, []byte(\"old\")); err != nil { panic(err) }\n\tif err := s.Put(\"k\", 2, []byte(\"new\")); err != nil { panic(err) }\n\ts.Compact()\n\tgen := s.NewGeneration()\n\tr, err := s.RegisterReader(gen, 1)\n\tif err != nil {\n\t\tfmt.Fprintf(os.Stderr, \"register seq=1 returned %v; expected reproduction of accepted stale snapshot\\n\", err)\n\t\tos.Exit(1)\n\t}\n\tvalue, found := r.Get(\"k\")\n\tfmt.Printf(\"RegisterReader(seq=1) after Compact: value=%q found=%t\\n\", value, found)\n\tif found || len(value) != 0 {\n\t\tfmt.Fprintln(os.Stderr, \"probe did not reproduce stale-snapshot miss\")\n\t\tos.Exit(1)\n\t}\n}\n"

B 探针完整输入文件 stale_reader_probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\n\t\"versionedtable/vtable\"\n)\n\nfunc main() {\n\ts := vtable.New()\n\tif err := s.Put(\"k\", 1, []byte(\"old\")); err != nil { panic(err) }\n\tif err := s.Put(\"k\", 2, []byte(\"new\")); err != nil { panic(err) }\n\tgen := s.NewGeneration()\n\tr, err := s.RegisterReader(gen, 1)\n\tif err != nil { panic(err) }\n\tr.Release()\n\ts.Compact()\n\tvalue, found := r.Get(\"k\")\n\tfmt.Printf(\"released handle after Compact: value=%q found=%t retained=%d\\n\", value, found, s.NumRecords(\"k\"))\n\tif found || len(value) != 0 {\n\t\tfmt.Fprintln(os.Stderr, \"probe did not reproduce stale-handle miss\")\n\t\tos.Exit(1)\n\t}\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/judge/pair/attempt-001/demonstration-B/demonstration/.gocache /usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/record/B/attempt-001/workspace run /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/judge/pair/attempt-001/demonstration-B/demonstration/stale_reader_probe.go\nreleased handle after Compact: value=\"\" found=false retained=1\n$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/judge/pair/attempt-001/demonstration-B/demonstration/.gocache /usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/record/B/attempt-001/workspace run /home/delin/.local/share/gsb-workbench/artifacts/774b041e4e054d39a2f9c8fbec2a02b7/judge/pair/attempt-001/demonstration-B/demonstration/compacted_snapshot_probe.go\nRegisterReader(seq=1) after Compact: value=\"\" found=false\n"

补充探针完整输入文件 B-release-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"versionedtable/vtable\"\n)\n\nfunc main() {\n\ts := vtable.New()\n\t_ = s.Put(\"k\", 1, []byte(\"old\"))\n\t_ = s.Put(\"k\", 2, []byte(\"new\"))\n\tgen := s.NewGeneration()\n\tr, _ := s.RegisterReader(gen, 1)\n\tr.Release()\n\ts.Compact()\n\tvalue, ok := r.Get(\"k\")\n\tfmt.Printf(\"after Release+Compact: value=%q found=%v retained=%d\\n\", value, ok, s.NumRecords(\"k\"))\n\n\tt := vtable.New()\n\t_ = t.Put(\"k\", 1, []byte(\"old\"))\n\t_ = t.Put(\"k\", 2, []byte(\"new\"))\n\tt.Compact()\n\tgen2 := t.NewGeneration()\n\toldReader, err := t.RegisterReader(gen2, 1)\n\tif err != nil {\n\t\tfmt.Printf(\"register old snapshot: error=%v\\n\", err)\n\t\treturn\n\t}\n\toldValue, oldOK := oldReader.Get(\"k\")\n\tfmt.Printf(\"after compact then RegisterReader(seq=1): value=%q found=%v\\n\", oldValue, oldOK)\n}\n"

补充输出 B-release-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："after Release+Compact: value=\"\" found=false retained=1\nafter compact then RegisterReader(seq=1): value=\"\" found=false\n"

补充探针完整输入文件 A-tombstone-conflict-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"vstore\"\n)\n\nfunc main() {\n\ts := vstore.NewStore()\n\t_ = s.Put(\"k\", 1, []byte(\"old\"))\n\t_ = s.Delete(\"k\", 2)\n\ts.Compact()\n\terr := s.Put(\"k\", 2, []byte(\"conflicting-value\"))\n\tfmt.Printf(\"after Compact, conflicting Put at tombstone seq=2: err=%v retained=%d\\n\", err, s.Len(\"k\"))\n}\n"

补充输出 A-tombstone-conflict-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："after Compact, conflicting Put at tombstone seq=2: err=<nil> retained=1\n"

补充输出 A-tombstone-conflict-probe-invocation.log以 JSON 字符串记录，解码后可还原完整原始输出："../../../../judge/pair/attempt-001/evidence/A-tombstone-conflict-probe.go:5:2: package vstore is not in std (/usr/local/go/src/vstore)\n"

补充探针完整输入文件 B-tombstone-conflict-probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"versionedtable/vtable\"\n)\n\nfunc main() {\n\ts := vtable.New()\n\t_ = s.Put(\"k\", 1, []byte(\"old\"))\n\t_ = s.Delete(\"k\", 2)\n\ts.Compact()\n\terr := s.Put(\"k\", 2, []byte(\"conflicting-value\"))\n\tfmt.Printf(\"after Compact, conflicting Put at tombstone seq=2: err=%v retained=%d\\n\", err, s.NumRecords(\"k\"))\n}\n"

补充输出 B-tombstone-conflict-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："after Compact, conflicting Put at tombstone seq=2: err=vtable: conflicting commit for key \"k\" at seq 2 retained=1\n"
