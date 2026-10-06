

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：25fd8eae41b5fdbfb0a3583995b7b32fd44873bc

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tlease\t1.015s\n"

A 预热命令：python3 '{support}/run_probe.py' '{workspace}' '{support}'

A 检查：到期时重复续期的幂等结果
复现命令：python3 '{support}/run_probe.py' '{workspace}' '{support}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 A-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package lease\n\nimport \"testing\"\n\nfunc TestProbeDuplicateRenewAfterExpiry(t *testing.T) {\n\tclock := NewClock()\n\tm := NewManager(clock)\n\ttok, err := m.Acquire(\"k\", 5)\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tclock.Advance(1)\n\tfirst := m.Renew(\"k\", tok.Generation, \"probe-request\", 3)\n\tif !first.Granted || first.ExpiresAt != 4 {\n\t\tt.Fatalf(\"first renewal = %+v\", first)\n\t}\n\tclock.Advance(3)\n\tduplicate := m.Renew(\"k\", tok.Generation, \"probe-request\", 100)\n\tif !duplicate.Granted || duplicate.ExpiresAt != first.ExpiresAt {\n\t\tt.Fatalf(\"duplicate = %+v, want original granted result with expiry %d\", duplicate, first.ExpiresAt)\n\t}\n\tt.Logf(\"first renewal granted through tick %d; duplicate at tick 4 replayed expiry %d\", first.ExpiresAt, duplicate.ExpiresAt)\n}\n"

A 探针完整输入文件 run_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nimport pathlib\nimport shutil\nimport subprocess\nimport sys\n\nworkspace = pathlib.Path(sys.argv[1]).resolve()\nsupport = pathlib.Path(sys.argv[2]).resolve()\ncopy = support / \"repro-workspace\"\nif copy.exists():\n    shutil.rmtree(copy)\ncopy.mkdir()\nfor name in (\"go.mod\", \"lease.go\", \"lease_test.go\"):\n    source = workspace / name\n    if source.exists():\n        shutil.copy2(source, copy / name)\nshutil.copy2(support / \"A-probe_test.go\", copy / \"A-probe_test.go\")\nenv = os.environ.copy()\nenv[\"GOCACHE\"] = str(support / \".gocache\")\ncmd = [\"/usr/local/go/bin/go\", \"-C\", str(copy), \"test\", \"-v\", \"-count=1\", \"-run\", \"^TestProbeDuplicateRenewAfterExpiry$\"]\ntry:\n    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45, env=env)\nexcept subprocess.TimeoutExpired as exc:\n    print(\"probe timed out\")\n    if exc.stdout:\n        print(exc.stdout if isinstance(exc.stdout, str) else exc.stdout.decode(errors=\"replace\"))\n    sys.exit(124)\nprint(result.stdout, end=\"\")\nsys.exit(result.returncode)\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/judge/pair/attempt-001/demonstration-A/demonstration/run_probe.py /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/record/A/attempt-001/workspace /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/judge/pair/attempt-001/demonstration-A/demonstration\n=== RUN   TestProbeDuplicateRenewAfterExpiry\n    A-probe_test.go:22: first renewal granted through tick 4; duplicate at tick 4 replayed expiry 4\n--- PASS: TestProbeDuplicateRenewAfterExpiry (0.00s)\nPASS\nok  \tlease\t0.002s\n"

B 产物提交：384cde404aba5f09abfb27e548f4a55249de0963

B 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tlease/lease\t1.022s\n"

B 预热命令：python3 '{support}/run_probe.py' warmup '{workspace}'

B 检查：原期限时重放续期
复现命令：python3 '{support}/run_probe.py' reproduce '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 duplicate_renew_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package lease\n\nimport \"testing\"\n\nfunc TestProbeDuplicateRenewAfterExpiry(t *testing.T) {\n\tclock := NewClock(0)\n\tm := NewManager(clock)\n\ttok, ok := m.Acquire(\"alice\", 5)\n\tif !ok {\n\t\tt.Fatal(\"initial acquire failed\")\n\t}\n\tclock.Advance(1)\n\tfirst, ok := m.Renew(\"alice\", tok.Generation, 42, 3)\n\tif !ok || first.Expiry != 4 {\n\t\tt.Fatalf(\"first renewal = %+v, ok=%v\", first, ok)\n\t}\n\tclock.Advance(3) // the retry happens exactly at the original deadline\n\tduplicate, ok := m.Renew(\"alice\", tok.Generation, 42, 100)\n\tif !ok || duplicate.Expiry != first.Expiry {\n\t\tt.Fatalf(\"duplicate = %+v, ok=%v; want original granted result with expiry %d\", duplicate, ok, first.Expiry)\n\t}\n}\n"

B 探针完整输入文件 run_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Run the duplicate-renew probe against an isolated copy of the workspace.\"\"\"\n\nimport os\nimport shutil\nimport subprocess\nimport sys\nimport tempfile\nfrom pathlib import Path\n\n\nGO = \"/usr/local/go/bin/go\"\nTIMEOUT = 120 if len(sys.argv) > 1 and sys.argv[1] == \"warmup\" else 45\n\n\ndef main() -> int:\n    if len(sys.argv) != 3 or sys.argv[1] not in {\"warmup\", \"reproduce\"}:\n        print(\"usage: run_probe.py warmup|reproduce WORKSPACE\", file=sys.stderr)\n        return 2\n    action, workspace_arg = sys.argv[1:]\n    support = Path(__file__).resolve().parent\n    workspace = Path(workspace_arg).resolve()\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(support / \".gocache\")\n    with tempfile.TemporaryDirectory(prefix=\"lease-probe-\", dir=support) as temp:\n        clone = Path(temp) / \"workspace\"\n        shutil.copytree(workspace, clone, ignore=shutil.ignore_patterns(\".git\"))\n        if action == \"warmup\":\n            args = [GO, \"test\", \"./...\"]\n        else:\n            probe = support / \"duplicate_renew_probe_test.go\"\n            shutil.copy2(probe, clone / \"lease\" / \"probe_test.go\")\n            args = [GO, \"test\", \"./...\", \"-run\", \"^TestProbeDuplicateRenewAfterExpiry$\", \"-count=1\"]\n        try:\n            result = subprocess.run(args, cwd=clone, env=env, text=True,\n                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n                                    timeout=TIMEOUT)\n        except subprocess.TimeoutExpired as exc:\n            output = exc.stdout or \"\"\n            if isinstance(output, bytes):\n                output = output.decode(errors=\"replace\")\n            if output:\n                print(output, end=\"\" if output.endswith(\"\\n\") else \"\\n\")\n            print(\"probe timed out\" if action == \"reproduce\" else \"warmup timed out\")\n            return 124\n        print(result.stdout, end=\"\" if result.stdout.endswith(\"\\n\") else \"\\n\")\n        return result.returncode\n\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/judge/pair/attempt-001/demonstration-B/demonstration/run_probe.py reproduce /home/delin/.local/share/gsb-workbench/artifacts/6bb68d388d594a50b80e5bba7551e4b6/record/B/attempt-001/workspace\n--- FAIL: TestProbeDuplicateRenewAfterExpiry (0.00s)\n    probe_test.go:20: duplicate = {Owner: Generation:0 Expiry:0}, ok=false; want original granted result with expiry 4\nFAIL\nFAIL\tlease/lease\t0.002s\nFAIL\n"

补充探针完整输入文件 A-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package lease\n\nimport \"testing\"\n\nfunc TestProbeDuplicateRenewAfterExpiry(t *testing.T) {\n\tclock := NewClock()\n\tm := NewManager(clock)\n\ttok, err := m.Acquire(\"k\", 5)\n\tif err != nil { t.Fatal(err) }\n\tclock.Advance(1)\n\tfirst := m.Renew(\"k\", tok.Generation, \"probe-request\", 3)\n\tif !first.Granted || first.ExpiresAt != 4 { t.Fatalf(\"first renewal = %+v\", first) }\n\tclock.Advance(3) // now equals the original renewal deadline\n\tduplicate := m.Renew(\"k\", tok.Generation, \"probe-request\", 100)\n\tif !duplicate.Granted || duplicate.ExpiresAt != first.ExpiresAt {\n\t\tt.Fatalf(\"duplicate = %+v, want original granted result with expiry %d\", duplicate, first.ExpiresAt)\n\t}\n}\n"

补充输出 A-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tlease\t0.003s\nEXIT_CODE=0\n"

补充探针完整输入文件 B-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package lease\n\nimport \"testing\"\n\nfunc TestProbeDuplicateRenewAfterExpiry(t *testing.T) {\n\tclock := NewClock(0)\n\tm := NewManager(clock)\n\ttok, ok := m.Acquire(\"alice\", 5)\n\tif !ok { t.Fatal(\"initial acquire failed\") }\n\tclock.Advance(1)\n\tfirst, ok := m.Renew(\"alice\", tok.Generation, 42, 3)\n\tif !ok || first.Expiry != 4 { t.Fatalf(\"first renewal = %+v, ok=%v\", first, ok) }\n\tclock.Advance(3) // now equals the original renewal deadline\n\tduplicate, ok := m.Renew(\"alice\", tok.Generation, 42, 100)\n\tif !ok || duplicate.Expiry != first.Expiry {\n\t\tt.Fatalf(\"duplicate = %+v, ok=%v; want original granted result with expiry %d\", duplicate, ok, first.Expiry)\n\t}\n}\n"

补充输出 B-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："--- FAIL: TestProbeDuplicateRenewAfterExpiry (0.00s)\n    probe_test.go:16: duplicate = {Owner: Generation:0 Expiry:0}, ok=false; want original granted result with expiry 4\nFAIL\nFAIL\tlease/lease\t0.003s\nFAIL\nEXIT_CODE=1\n"
