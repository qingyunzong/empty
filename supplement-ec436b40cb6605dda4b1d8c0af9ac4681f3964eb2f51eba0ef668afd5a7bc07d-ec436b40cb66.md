

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：7b2f29d611c95d1b702e358e8833c0787c1837d5

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tcircuitbreaker\t1.125s\n"

A 预热命令：python3 '{support}/probe.py' '{workspace}' --warmup

A 检查：重复失败结算
复现命令：python3 '{support}/probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nfrom pathlib import Path\nimport shutil\nimport subprocess\nimport sys\n\nsupport = Path(__file__).resolve().parent\nworkspace = Path(sys.argv[1]).resolve()\nwarmup = len(sys.argv) > 2 and sys.argv[2] == \"--warmup\"\nprobe_dir = support / \".probe-src\"\nprobe_dir.mkdir(exist_ok=True)\nfor name in (\"go.mod\", \"breaker.go\", \"clock.go\"):\n    shutil.copy2(workspace / name, probe_dir / name)\nshutil.copy2(support / \"probe_test.go\", probe_dir / \"probe_test.go\")\nenv = os.environ.copy()\nenv[\"GOCACHE\"] = str(support / \".gocache\")\nargs = [\"/usr/local/go/bin/go\", \"test\", \"-count=1\", \"-v\"]\nif warmup:\n    args += [\"-run\", \"^$\"]\nelse:\n    args += [\"-run\", \"^TestDuplicateFailureIsCountedOnce$\"]\nresult = subprocess.run(args, cwd=probe_dir, env=env, text=True,\n                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n                        timeout=45)\nif warmup:\n    print(\"probe compiled successfully\" if result.returncode == 0 else result.stdout[-1200:])\nelse:\n    print(result.stdout, end=\"\")\n    if result.returncode != 1 or \"OBSERVED state after duplicate Failure: open\" not in result.stdout or \"OBSERVED subsequent Allow: circuitbreaker: breaker is open\" not in result.stdout:\n        print(\"probe did not reproduce the expected behavior\")\n        sys.exit(2)\nsys.exit(result.returncode)\n"

A 探针完整输入文件 probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package circuitbreaker\n\nimport (\n\t\"testing\"\n\t\"time\"\n)\n\ntype probeClock struct{ now time.Time }\n\nfunc (c probeClock) Now() time.Time { return c.now }\n\nfunc TestDuplicateFailureIsCountedOnce(t *testing.T) {\n\tb := New(2, time.Minute, 1, probeClock{now: time.Unix(1, 0)})\n\tgeneration, err := b.Allow()\n\tif err != nil {\n\t\tt.Fatalf(\"initial Allow: %v\", err)\n\t}\n\tb.Failure(generation)\n\tb.Failure(generation)\n\tstate := b.State()\n\t_, allowErr := b.Allow()\n\tt.Logf(\"OBSERVED state after duplicate Failure: %s\", state)\n\tif allowErr != nil {\n\t\tt.Logf(\"OBSERVED subsequent Allow: %v\", allowErr)\n\t} else {\n\t\tt.Log(\"OBSERVED subsequent Allow: admitted\")\n\t}\n\tif state != StateClosed {\n\t\tt.Errorf(\"expected one request failure to leave breaker closed; got %s\", state)\n\t}\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/judge/pair/attempt-001/demonstration-A/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/record/A/attempt-001/workspace\n=== RUN   TestDuplicateFailureIsCountedOnce\n    probe_test.go:22: OBSERVED state after duplicate Failure: open\n    probe_test.go:24: OBSERVED subsequent Allow: circuitbreaker: breaker is open\n    probe_test.go:29: expected one request failure to leave breaker closed; got open\n--- FAIL: TestDuplicateFailureIsCountedOnce (0.00s)\nFAIL\nexit status 1\nFAIL\tcircuitbreaker\t0.005s\n"

B 产物提交：a1e0a4e08c779e10866c59426a63d5d0ed8c9112

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tbreaker\t1.031s\n"

B 预热命令：python3 '{support}/probe.py' '{workspace}' warmup

B 检查：半开周期探测总量上限
复现命令：python3 '{support}/probe.py' '{workspace}' reproduce
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport json\nimport os\nimport subprocess\nimport sys\nimport tempfile\nfrom pathlib import Path\n\n\nGO = \"/usr/local/go/bin/go\"\n\n\ndef main() -> int:\n    if len(sys.argv) != 3 or sys.argv[2] not in {\"warmup\", \"reproduce\"}:\n        print(\"usage: probe.py WORKSPACE warmup|reproduce\", file=sys.stderr)\n        return 2\n    workspace = Path(sys.argv[1]).resolve()\n    support = Path(__file__).resolve().parent\n    overlay_target = workspace / \"zz_episode_probe_test.go\"\n    with tempfile.NamedTemporaryFile(mode=\"w\", suffix=\".json\", encoding=\"utf-8\", delete=False) as f:\n        json.dump({\"Replace\": {str(overlay_target): str(support / \"probe_test.go\")}}, f)\n        overlay = f.name\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(support / \".gocache\")\n    cmd = [GO, \"-C\", str(workspace), \"test\", \"-overlay\", overlay]\n    if sys.argv[2] == \"warmup\":\n        cmd += [\"-run\", \"^$\", \"-count=1\", \"./...\"]\n    else:\n        cmd += [\"-run\", \"^TestHalfOpenEpisodeProbeBudget$\", \"-count=1\", \"./...\"]\n    try:\n        result = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)\n        if result.stdout:\n            print(result.stdout, end=\"\" if result.stdout.endswith(\"\\n\") else \"\\n\")\n        return result.returncode\n    finally:\n        Path(overlay).unlink(missing_ok=True)\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n"

B 探针完整输入文件 probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package breaker\n\nimport (\n\t\"errors\"\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestHalfOpenEpisodeProbeBudget(t *testing.T) {\n\tclk := &episodeProbeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}\n\tb := New(Options{\n\t\tFailureThreshold:  1,\n\t\tOpenDuration:      time.Minute,\n\t\tMaxProbes:         2,\n\t\tRequiredSuccesses: 2,\n\t\tClock:             clk,\n\t})\n\tp, err := b.Acquire()\n\tif err != nil {\n\t\tt.Fatalf(\"initial acquire: %v\", err)\n\t}\n\tp.Failure()\n\tclk.advance(time.Minute)\n\tp1, err := b.Acquire()\n\tif err != nil {\n\t\tt.Fatalf(\"first probe: %v\", err)\n\t}\n\t_, err = b.Acquire()\n\tif err != nil {\n\t\tt.Fatalf(\"second probe: %v\", err)\n\t}\n\tp1.Success()\n\n\t_, err = b.Acquire()\n\tif errors.Is(err, ErrProbeLimit) {\n\t\tt.Logf(\"observed total half-open permits=2 (K=2); third acquire rejected: %v\", err)\n\t\treturn\n\t}\n\tif err != nil {\n\t\tt.Fatalf(\"third acquire returned unexpected error: %v\", err)\n\t}\n\tt.Fatalf(\"observed total half-open permits=3 (K=2); third acquire succeeded after a probe settled\")\n}\n\ntype episodeProbeClock struct{ now time.Time }\n\nfunc (c *episodeProbeClock) Now() time.Time { return c.now }\nfunc (c *episodeProbeClock) advance(d time.Duration) { c.now = c.now.Add(d) }\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/judge/pair/attempt-001/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/99252970d81442cbb20d44825cabcd96/record/B/attempt-001/workspace reproduce\n--- FAIL: TestHalfOpenEpisodeProbeBudget (0.00s)\n    zz_episode_probe_test.go:42: observed total half-open permits=3 (K=2); third acquire succeeded after a probe settled\nFAIL\nFAIL\tbreaker\t0.003s\nFAIL\n"

补充探针完整输入文件 duplicate_settlement_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package circuitbreaker\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestDuplicateSettlementObservation(t *testing.T) {\n\tb := New(2, time.Minute, 1, newFakeClock())\n\tgeneration, err := b.Allow()\n\tif err != nil { t.Fatal(err) }\n\tb.Failure(generation)\n\tfmt.Printf(\"after first Failure: state=%s generation=%d\\n\", b.State(), b.Generation())\n\tb.Failure(generation)\n\tfmt.Printf(\"after duplicate Failure: state=%s generation=%d\\n\", b.State(), b.Generation())\n}\n"

补充输出 output.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestDuplicateSettlementObservation\nafter first Failure: state=closed generation=0\nafter duplicate Failure: state=open generation=1\n--- PASS: TestDuplicateSettlementObservation (0.00s)\nPASS\nok  \tcircuitbreaker\t0.006s\n"

补充探针完整输入文件 duplicate_settlement_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package breaker\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestDuplicateSettlementObservation(t *testing.T) {\n\tb := New(Options{FailureThreshold: 2, OpenDuration: time.Minute, MaxProbes: 1, RequiredSuccesses: 1, Clock: newFakeClock()})\n\tp := mustAcquire(t, b)\n\tp.Failure()\n\tfmt.Printf(\"after first Failure: state=%s generation=%d\\n\", b.State(), b.Generation())\n\tp.Failure()\n\tfmt.Printf(\"after duplicate Failure: state=%s generation=%d\\n\", b.State(), b.Generation())\n}\n"

补充输出 output.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestDuplicateSettlementObservation\nafter first Failure: state=closed generation=0\nafter duplicate Failure: state=closed generation=0\n--- PASS: TestDuplicateSettlementObservation (0.00s)\nPASS\nok  \tbreaker\t0.002s\n"
