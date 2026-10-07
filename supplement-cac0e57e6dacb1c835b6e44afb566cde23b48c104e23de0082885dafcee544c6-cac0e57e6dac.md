

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：691895671a4fb42d57e2dec6f72d267299d85113

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tpagestore\t1.032s\n"

A 预热命令：python3 '{support}/probe.py' --warmup '{workspace}'

A 检查：尾部零字节往返
复现命令：python3 '{support}/probe.py' --run '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nimport shutil\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nHERE = Path(__file__).resolve().parent\nREPLICA = HERE / \"replica\"\nGO = \"/usr/local/go/bin/go\"\n\ndef main():\n    if len(sys.argv) != 3 or sys.argv[1] not in (\"--warmup\", \"--run\"):\n        return 2\n    workspace = Path(sys.argv[2]).resolve()\n    REPLICA.mkdir(exist_ok=True)\n    for name in (\"backend.go\", \"pagestore.go\", \"go.mod\"):\n        shutil.copy2(workspace / name, REPLICA / name)\n    shutil.copy2(HERE / \"probe_test.go\", REPLICA / \"tail_zero_probe_test.go\")\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(HERE / \"gocache\")\n    env[\"GOTOOLCHAIN\"] = \"local\"\n    pattern = \"^$\" if sys.argv[1] == \"--warmup\" else \"^TestTailZeroRoundTrip$\"\n    result = subprocess.run(\n        [GO, \"-C\", str(REPLICA), \"test\", \"-count=1\", \"-run\", pattern, \"-v\"],\n        env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n    )\n    sys.stdout.write(result.stdout)\n    return result.returncode\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

A 探针完整输入文件 probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"bytes\"\n\t\"testing\"\n)\n\nfunc TestTailZeroRoundTrip(t *testing.T) {\n\twant := []byte{'x', 0}\n\ts, err := Open(NewMemBackend(), 8)\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\ttx := s.Begin()\n\tif err := tx.Put(\"tail-zero\", want); err != nil {\n\t\tt.Fatal(err)\n\t}\n\tif err := tx.Commit(); err != nil {\n\t\tt.Fatal(err)\n\t}\n\tv := s.BeginRead()\n\tdefer v.Close()\n\tgot, ok, err := v.Get(\"tail-zero\")\n\tif err != nil || !ok {\n\t\tt.Fatalf(\"Get ok=%v err=%v\", ok, err)\n\t}\n\tif !bytes.Equal(got, want) {\n\t\tt.Fatalf(\"round-trip got %v want %v\", got, want)\n\t}\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/judge/pair/attempt-002/demonstration-A/demonstration/probe.py --run /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/record/A/attempt-001/workspace\n=== RUN   TestTailZeroRoundTrip\n    tail_zero_probe_test.go:28: round-trip got [120] want [120 0]\n--- FAIL: TestTailZeroRoundTrip (0.00s)\nFAIL\nexit status 1\nFAIL\tpagestore\t0.007s\n"

B 产物提交：77eeb0d740a03648ad0fc985c84d0a953fbe0b3c

B 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tpagestore\t1.073s\n"

B 预热命令：/usr/bin/python3 '{support}/probe.py' '{workspace}' warmup

B 检查：覆盖提交后的物理页回收
复现命令：/usr/bin/python3 '{support}/probe.py' '{workspace}' reproduce
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 physical_pages_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n)\n\n// This probe measures the durable backend directly after repeated overwrites.\n// The failure report includes observed counts rather than an assumed leak.\nfunc TestPhysicalPageReuseProbe(t *testing.T) {\n\tbackend := NewMemBackend()\n\tstore := NewStore(backend, 8)\n\tfor i := 0; i < 30; i++ {\n\t\ttx := store.Begin()\n\t\ttx.Put(\"same-key\", []byte(fmt.Sprintf(\"generation-%d\", i)))\n\t\tif err := tx.Commit(); err != nil {\n\t\t\tt.Fatalf(\"commit %d: %v\", i, err)\n\t\t}\n\t}\n\tphysical := len(backend.Pages)\n\tstats := store.Stats()\n\tif physical > stats.Capacity {\n\t\tt.Fatalf(\"physical pages exceed capacity: backend pages=%d capacity=%d logical used=%d\", physical, stats.Capacity, stats.Used)\n\t}\n\tt.Logf(\"backend pages=%d capacity=%d logical used=%d\", physical, stats.Capacity, stats.Used)\n}\n"

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport json\nimport os\nimport re\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nGO = \"/usr/local/go/bin/go\"\nSUPPORT = Path(__file__).resolve().parent\nTEST_SOURCE = SUPPORT / \"physical_pages_test.go\"\nOVERLAY = SUPPORT / \"overlay.json\"\nCACHE = SUPPORT / \"gocache\"\n\n\ndef run(args, cwd, env, timeout):\n    try:\n        result = subprocess.run(args, cwd=cwd, env=env, text=True,\n                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n                                timeout=timeout)\n        output = result.stdout.strip()\n        if output:\n            print(output)\n        return result.returncode\n    except subprocess.TimeoutExpired as exc:\n        partial = exc.stdout or \"\"\n        if isinstance(partial, bytes):\n            partial = partial.decode(errors=\"replace\")\n        if partial.strip():\n            print(partial.strip())\n        print(\"probe timed out\")\n        return 124\n\n\ndef main():\n    if len(sys.argv) != 3 or sys.argv[2] not in (\"warmup\", \"reproduce\"):\n        print(\"usage: probe.py WORKSPACE warmup|reproduce\")\n        return 2\n    workspace = Path(sys.argv[1]).resolve()\n    if not (workspace / \"go.mod\").is_file():\n        print(\"workspace go.mod not found\")\n        return 2\n    CACHE.mkdir(exist_ok=True)\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(CACHE)\n    version = subprocess.run([GO, \"version\"], text=True, stdout=subprocess.PIPE,\n                             stderr=subprocess.STDOUT, timeout=10)\n    print(version.stdout.strip())\n    match = re.search(r\"go(\\d+)\\.(\\d+)\", version.stdout)\n    if version.returncode or not match or tuple(map(int, match.groups())) < (1, 23):\n        print(\"Go 1.23 or newer is required by this workspace\")\n        return 2\n    virtual_test = workspace / \"physical_pages_probe_test.go\"\n    OVERLAY.write_text(json.dumps({\"Replace\": {str(virtual_test): str(TEST_SOURCE)}}))\n    args = [GO, \"test\", \"-overlay=\" + str(OVERLAY)]\n    if sys.argv[2] == \"warmup\":\n        args += [\"-run=^$\", \"./...\"]\n        return run(args, workspace, env, 120)\n    args += [\"-run=^TestPhysicalPageReuseProbe$\", \"-count=1\", \"./...\"]\n    return run(args, workspace, env, 45)\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/judge/pair/attempt-002/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/b0083b53cd7243de857ccf518c135aaa/record/B/attempt-001/workspace reproduce\ngo version go1.27.1 linux/amd64\n--- FAIL: TestPhysicalPageReuseProbe (0.00s)\n    physical_pages_probe_test.go:23: physical pages exceed capacity: backend pages=30 capacity=8 logical used=1\nFAIL\nFAIL\tpagestore\t0.009s\nFAIL\n"

补充探针完整输入文件 A-physical-reuse_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n)\n\nfunc TestPhysicalPageReuseProbe(t *testing.T) {\n\tbackend := NewMemBackend()\n\ts, err := Open(backend, 8)\n\tif err != nil { t.Fatal(err) }\n\tfor i := 0; i < 30; i++ {\n\t\ttx := s.Begin()\n\t\tif err := tx.Put(\"k\", []byte(fmt.Sprintf(\"v%d\", i))); err != nil { t.Fatal(err) }\n\t\tif err := tx.Commit(); err != nil { t.Fatalf(\"commit %d: %v\", i, err) }\n\t}\n\tfmt.Printf(\"commits=30 capacity=%d used=%d backend_pages=%d\\\\n\", s.Stats().Capacity, s.Stats().Used, len(backend.pages))\n\tif len(backend.pages) > s.Stats().Capacity { t.Fatalf(\"backend retained %d pages beyond capacity %d\", len(backend.pages), s.Stats().Capacity) }\n}\n"

补充输出 A-physical-reuse.log以 JSON 字符串记录，解码后可还原完整原始输出："commits=30 capacity=8 used=2 backend_pages=4\\nPASS\nok  \tpagestore\t0.003s\nexit=0\n"

补充探针完整输入文件 B-physical-reuse_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n)\n\nfunc TestPhysicalPageReuseProbe(t *testing.T) {\n\tbackend := NewMemBackend()\n\ts := NewStore(backend, 8)\n\tfor i := 0; i < 30; i++ {\n\t\ttx := s.Begin()\n\t\ttx.Put(\"k\", []byte(fmt.Sprintf(\"v%d\", i)))\n\t\tif err := tx.Commit(); err != nil { t.Fatalf(\"commit %d: %v\", i, err) }\n\t}\n\tfmt.Printf(\"commits=30 capacity=%d used=%d backend_pages=%d\\\\n\", s.Stats().Capacity, s.Stats().Used, len(backend.Pages))\n\tif len(backend.Pages) > s.Stats().Capacity { t.Fatalf(\"backend retained %d pages beyond capacity %d\", len(backend.Pages), s.Stats().Capacity) }\n}\n"

补充输出 B-physical-reuse.log以 JSON 字符串记录，解码后可还原完整原始输出："commits=30 capacity=8 used=1 backend_pages=30\\n--- FAIL: TestPhysicalPageReuseProbe (0.00s)\n    pageprobe_test.go:17: backend retained 30 pages beyond capacity 8\nFAIL\nexit status 1\nFAIL\tpagestore\t0.003s\nexit=1\n"

补充探针完整输入文件 A-value-integrity_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"bytes\"\n\t\"testing\"\n)\n\nfunc TestTrailingZeroValueProbe(t *testing.T) {\n\ts, err := Open(NewMemBackend(), 8)\n\tif err != nil { t.Fatal(err) }\n\twant := []byte{'x', 0}\n\ttx := s.Begin()\n\tif err := tx.Put(\"k\", want); err != nil { t.Fatal(err) }\n\tif err := tx.Commit(); err != nil { t.Fatal(err) }\n\tv := s.BeginRead()\n\tdefer v.Close()\n\tgot, ok, err := v.Get(\"k\")\n\tif err != nil || !ok { t.Fatalf(\"Get: ok=%v err=%v\", ok, err) }\n\tif !bytes.Equal(got, want) { t.Fatalf(\"got=%v want=%v\", got, want) }\n}\n"

补充输出 A-value-integrity.log以 JSON 字符串记录，解码后可还原完整原始输出："--- FAIL: TestTrailingZeroValueProbe (0.00s)\n    valueprobe_test.go:19: got=[120] want=[120 0]\nFAIL\nexit status 1\nFAIL\tpagestore\t0.005s\nexit=1\n"

补充探针完整输入文件 B-value-integrity_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package pagestore\n\nimport (\n\t\"bytes\"\n\t\"testing\"\n)\n\nfunc TestTrailingZeroValueProbe(t *testing.T) {\n\ts := NewStore(NewMemBackend(), 8)\n\ttx := s.Begin()\n\ttx.Put(\"k\", []byte{'x', 0})\n\tif err := tx.Commit(); err != nil { t.Fatal(err) }\n\tr := s.Acquire()\n\tdefer r.Close()\n\tgot, ok := r.Get(\"k\")\n\twant := []byte{'x', 0}\n\tif !ok || !bytes.Equal(got, want) { t.Fatalf(\"got=%v ok=%v want=%v\", got, ok, want) }\n}\n"

补充输出 B-value-integrity.log以 JSON 字符串记录，解码后可还原完整原始输出："PASS\nok  \tpagestore\t0.005s\nexit=0\n"
