

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：b4fa6ec6287bf7628c825a19b7ad4e540d67c778

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tauthlib\t1.071s\n"

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go -C '{workspace}' build -o '{support}/probe' '{support}/probe.go'

A 检查：负额度进入授权状态
复现命令：'{support}/probe'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\t\"path/filepath\"\n\n\t\"authlib\"\n)\n\nfunc main() {\n\tpath := filepath.Join(os.TempDir(), fmt.Sprintf(\"quota-negative-%d.wal\", os.Getpid()))\n\tdefer os.Remove(path)\n\n\ts, err := authlib.Open(path)\n\tif err != nil {\n\t\tfmt.Printf(\"open error: %v\\n\", err)\n\t\tos.Exit(2)\n\t}\n\tif err := s.Grant(\"probe-token\", -1); err != nil {\n\t\tfmt.Printf(\"grant error: %v\\n\", err)\n\t\ts.Close()\n\t\tos.Exit(2)\n\t}\n\tremaining, err := s.Remaining(\"probe-token\")\n\tif err != nil {\n\t\tfmt.Printf(\"remaining error: %v\\n\", err)\n\t\ts.Close()\n\t\tos.Exit(2)\n\t}\n\tfmt.Printf(\"Grant(k=-1) succeeded; Remaining=%d\\n\", remaining)\n\tif err := s.Close(); err != nil {\n\t\tfmt.Printf(\"close error: %v\\n\", err)\n\t\tos.Exit(2)\n\t}\n\tif remaining < 0 {\n\t\tos.Exit(1)\n\t}\n\tfmt.Println(\"negative quota was not reproduced\")\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/judge/pair/attempt-086/demonstration-A/demonstration/probe\nGrant(k=-1) succeeded; Remaining=-1\n"

B 产物提交：e7643d7faa79639f447ec456224f36b7867e95da

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tauthlib\t1.105s\n"

B 预热命令：python3 '{support}/probe.py' '{workspace}'

B 检查：负额度签发校验
复现命令：python3 '{support}/probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nimport pathlib\nimport shutil\nimport subprocess\nimport sys\n\nsupport = pathlib.Path(__file__).resolve().parent\nworkspace = pathlib.Path(sys.argv[1]).resolve()\nstage = support / \".quota-probe-work\"\ncache = support / \".gocache\"\n\nif stage.exists():\n    shutil.rmtree(stage)\nshutil.copytree(workspace, stage)\nshutil.copy2(support / \"quota_probe_test.go\", stage / \"quota_probe_test.go\")\ncache.mkdir(exist_ok=True)\nenv = os.environ.copy()\nenv[\"GOCACHE\"] = str(cache)\ncommand = [\n    \"/usr/local/go/bin/go\", \"-C\", str(stage), \"test\",\n    \"-run\", \"^TestRejectNegativeQuota$\", \"-v\",\n]\ntry:\n    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,\n                            stderr=subprocess.STDOUT, timeout=45)\nexcept subprocess.TimeoutExpired as exc:\n    output = exc.stdout or \"\"\n    if isinstance(output, bytes):\n        output = output.decode(errors=\"replace\")\n    shutil.rmtree(stage, ignore_errors=True)\n    print(output, end=\"\")\n    print(\"probe timed out\")\n    sys.exit(124)\nshutil.rmtree(stage, ignore_errors=True)\nprint(result.stdout, end=\"\")\nsys.exit(result.returncode)\n"

B 探针完整输入文件 quota_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package authlib\n\nimport (\n\t\"errors\"\n\t\"testing\"\n)\n\nfunc TestRejectNegativeQuota(t *testing.T) {\n\ts, err := Open(t.TempDir() + \"/wal\")\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tdefer s.Close()\n\n\terr = s.Issue(\"negative\", -1)\n\tif !errors.Is(err, ErrInvalidAmount) {\n\t\tt.Fatalf(\"Issue(-1) error = %v; want ErrInvalidAmount\", err)\n\t}\n\tif _, err := s.Remaining(\"negative\"); !errors.Is(err, ErrUnknownToken) {\n\t\tt.Fatalf(\"negative quota created token: Remaining error = %v\", err)\n\t}\n\tt.Log(\"Issue(-1) returned ErrInvalidAmount; token state remains absent\")\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/judge/pair/attempt-086/demonstration-B/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/record/B/attempt-001/workspace\n=== RUN   TestRejectNegativeQuota\n    quota_probe_test.go:22: Issue(-1) returned ErrInvalidAmount; token state remains absent\n--- PASS: TestRejectNegativeQuota (0.00s)\nPASS\nok  \tauthlib\t0.003s\n"

补充探针完整输入文件 quota-boundary-probe.sh以 JSON 字符串记录，解码后可还原完整输入文件："#!/bin/sh\nset -u\nbase=evidence/quota-probe-work\nrm -rf \"$base\"\nmkdir -p \"$base\"\nfor side in A B; do\n  if [ \"$side\" = A ]; then\n    src=/home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/run/A/attempt-001/workspace\n    mkdir -p \"$base/A\"\n    cp \"$src\"/go.mod \"$src\"/store.go \"$base/A/\"\n    dir=\"$base/A\"\n    cat > \"$dir/quota_probe_test.go\" <<'EOF'\npackage authlib\nimport \"testing\"\nfunc TestRejectNegativeQuota(t *testing.T) {\n s, err := Open(t.TempDir()+\"/wal\")\n if err != nil { t.Fatal(err) }\n defer s.Close()\n err = s.Grant(\"negative\", -1)\n if err == nil { remaining, _ := s.Remaining(\"negative\"); t.Fatalf(\"negative quota accepted; Remaining=%d\", remaining) }\n}\nEOF\n  else\n    src=/home/delin/.local/share/gsb-workbench/artifacts/362366761f0042638036eeb2ace9656b/run/B/attempt-004/workspace\n    mkdir -p \"$base/B\"\n    cp \"$src\"/go.mod \"$src\"/authlib.go \"$base/B/\"\n    dir=\"$base/B\"\n    cat > \"$dir/quota_probe_test.go\" <<'EOF'\npackage authlib\nimport \"testing\"\nfunc TestRejectNegativeQuota(t *testing.T) {\n s, err := Open(t.TempDir()+\"/wal\")\n if err != nil { t.Fatal(err) }\n defer s.Close()\n err = s.Issue(\"negative\", -1)\n if err == nil { remaining, _ := s.Remaining(\"negative\"); t.Fatalf(\"negative quota accepted; Remaining=%d\", remaining) }\n}\nEOF\n  fi\n  printf '\\n[%s] go version: ' \"$side\"\n  /usr/local/bin/go version\n  printf '[%s] command: GOCACHE=/tmp/gsb-quota-cache-%s /usr/local/bin/go -C %s test -run TestRejectNegativeQuota -v\\n' \"$side\" \"$side\" \"$dir\"\n  GOCACHE=\"/tmp/gsb-quota-cache-$side\" /usr/local/bin/go -C \"$dir\" test -run TestRejectNegativeQuota -v\n  rc=$?\n  printf '[%s] exitCode=%s\\n' \"$side\" \"$rc\"\ndone\n"

补充输出 quota-boundary-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："\n[A] go version: go version go1.27.1 linux/amd64\n[A] command: GOCACHE=/tmp/gsb-quota-cache-A /usr/local/bin/go -C evidence/quota-probe-work/A test -run TestRejectNegativeQuota -v\n=== RUN   TestRejectNegativeQuota\n    quota_probe_test.go:8: negative quota accepted; Remaining=-1\n--- FAIL: TestRejectNegativeQuota (0.00s)\nFAIL\nexit status 1\nFAIL\tauthlib\t0.004s\n[A] exitCode=1\n\n[B] go version: go version go1.27.1 linux/amd64\n[B] command: GOCACHE=/tmp/gsb-quota-cache-B /usr/local/bin/go -C evidence/quota-probe-work/B test -run TestRejectNegativeQuota -v\n=== RUN   TestRejectNegativeQuota\n--- PASS: TestRejectNegativeQuota (0.00s)\nPASS\nok  \tauthlib\t0.003s\n[B] exitCode=0\n"

补充探针完整输入文件 quota_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package authlib\nimport \"testing\"\nfunc TestRejectNegativeQuota(t *testing.T) {\n s, err := Open(t.TempDir()+\"/wal\")\n if err != nil { t.Fatal(err) }\n defer s.Close()\n err = s.Grant(\"negative\", -1)\n if err == nil { remaining, _ := s.Remaining(\"negative\"); t.Fatalf(\"negative quota accepted; Remaining=%d\", remaining) }\n}\n"

补充探针完整输入文件 quota_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package authlib\nimport \"testing\"\nfunc TestRejectNegativeQuota(t *testing.T) {\n s, err := Open(t.TempDir()+\"/wal\")\n if err != nil { t.Fatal(err) }\n defer s.Close()\n err = s.Issue(\"negative\", -1)\n if err == nil { remaining, _ := s.Remaining(\"negative\"); t.Fatalf(\"negative quota accepted; Remaining=%d\", remaining) }\n}\n"
