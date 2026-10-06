

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：679b33c746fbb94feb9dab01140ff59f76b12b05

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tobjstore\t1.095s\n"

A 预热命令：/usr/bin/python3 '{support}/probe.py' version '{workspace}'

A 预热命令：/usr/bin/python3 '{support}/probe.py' warmup '{workspace}'

A 检查：GC 崩溃后恢复
复现命令：/usr/bin/python3 '{support}/probe.py' crash '{workspace}'

A 检查：删除前新增根
复现命令：/usr/bin/python3 '{support}/probe.py' root '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Run one focused, existing object-store behavior test with a stable cache.\"\"\"\n\nimport os\nimport subprocess\nimport sys\nfrom pathlib import Path\n\n\nGO = \"/usr/local/go/bin/go\"\nTESTS = {\n    \"crash\": \"TestCrashDuringGC\",\n    \"root\": \"TestGCNewRootBeforeDelete\",\n}\n\n\ndef main() -> int:\n    if len(sys.argv) != 3 or sys.argv[1] not in {\"version\", \"warmup\", *TESTS}:\n        print(\"usage: probe.py {version|warmup|crash|root} WORKSPACE\", file=sys.stderr)\n        return 2\n\n    mode, workspace = sys.argv[1], sys.argv[2]\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(Path(__file__).resolve().parent / \"gocache\")\n\n    if mode == \"version\":\n        command = [GO, \"version\"]\n    elif mode == \"warmup\":\n        command = [GO, \"-C\", workspace, \"test\", \"-run\", \"^$\", \"./...\"]\n    else:\n        command = [\n            GO,\n            \"-C\",\n            workspace,\n            \"test\",\n            \"-v\",\n            \"-count=1\",\n            \"-run\",\n            f\"^{TESTS[mode]}$\",\n            \"./...\",\n        ]\n    return subprocess.run(command, env=env, check=False).returncode\n\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/judge/pair/attempt-001/demonstration-A/demonstration/probe.py crash /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/record/A/attempt-001/workspace\n=== RUN   TestCrashDuringGC\n--- PASS: TestCrashDuringGC (0.00s)\nPASS\nok  \tobjstore\t0.004s\n$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/judge/pair/attempt-001/demonstration-A/demonstration/probe.py root /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/record/A/attempt-001/workspace\n=== RUN   TestGCNewRootBeforeDelete\n--- PASS: TestGCNewRootBeforeDelete (0.00s)\nPASS\nok  \tobjstore\t0.003s\n"

B 产物提交：c57d1e95b95c9e01b1aba512aed3b03455dfc14b

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tobjstore\t2.661s\n"

B 预热命令：python3 '{support}/run_probe.py' prepare '{workspace}'

B 预热命令：python3 '{support}/run_probe.py' warmup

B 检查：重开时恢复中断的 GC
复现命令：python3 '{support}/run_probe.py' recovery

B 检查：标记后新增根的写屏障
复现命令：python3 '{support}/run_probe.py' barrier
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe_barrier_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package objstore\n\nimport (\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestProbeAfterMarkRootBarrier(t *testing.T) {\n\tnow := time.Now()\n\tclock := func() time.Time { return now }\n\tvar s *Store\n\tadded := false\n\ts, err := Open(t.TempDir(), &Options{MinAge: time.Minute, Now: clock, Hooks: Hooks{\n\t\tAfterMark: func() {\n\t\t\tif added { return }\n\t\t\tadded = true\n\t\t\tlate, err := s.Put([]byte(\"late-root-target\"), nil)\n\t\t\tif err != nil { t.Errorf(\"Put late target: %v\", err); return }\n\t\t\tnow = now.Add(2 * time.Minute) // expire its temporary lease\n\t\t\tif err := s.SetRoot(\"late\", late); err != nil { t.Errorf(\"SetRoot late: %v\", err) }\n\t\t},\n\t}})\n\tif err != nil { t.Fatal(err) }\n\tdefer s.Close()\n\tbase, err := s.Put([]byte(\"base-root\"), nil)\n\tif err != nil { t.Fatal(err) }\n\tif err := s.SetRoot(\"base\", base); err != nil { t.Fatal(err) }\n\tgarbage, err := s.Put([]byte(\"expired-garbage\"), nil)\n\tif err != nil { t.Fatal(err) }\n\tnow = now.Add(2 * time.Minute)\n\tevs, err := s.Collect()\n\tif err != nil { t.Fatal(err) }\n\tlate := s.Roots()[\"late\"]\n\tif late == \"\" || !s.Has(late) { t.Fatal(\"new root target swept\") }\n\tif !s.Has(base) { t.Fatal(\"pre-existing root swept\") }\n\tif s.Has(garbage) { t.Fatal(\"expired unreachable object survived\") }\n\tif len(evs) != 1 || evs[0].Object != garbage { t.Fatalf(\"deletion evidence does not match actual deletion: %+v\", evs) }\n\tt.Logf(\"late_root_survived=true expired_garbage_removed=true evidence_matches=%d\", len(evs))\n}\n"

B 探针完整输入文件 probe_recovery_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package objstore\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestProbeStartupRecovery(t *testing.T) {\n\tdir := t.TempDir()\n\tinterrupted := false\n\ts, err := Open(dir, &Options{MinAge: time.Millisecond, Hooks: Hooks{\n\t\tBeforeDelete: func(ID) error {\n\t\t\tif !interrupted {\n\t\t\t\tinterrupted = true\n\t\t\t\treturn fmt.Errorf(\"probe crash after journal append\")\n\t\t\t}\n\t\t\treturn nil\n\t\t},\n\t}})\n\tif err != nil { t.Fatal(err) }\n\tleaf, err := s.Put([]byte(\"reachable-leaf\"), nil)\n\tif err != nil { t.Fatal(err) }\n\troot, err := s.Put([]byte(\"reachable-root\"), []ID{leaf})\n\tif err != nil { t.Fatal(err) }\n\tif err := s.SetRoot(\"v1\", root); err != nil { t.Fatal(err) }\n\tgarbage := make([]ID, 3)\n\tfor i := range garbage {\n\t\tgarbage[i], err = s.Put([]byte(fmt.Sprintf(\"garbage-%d\", i)), nil)\n\t\tif err != nil { t.Fatal(err) }\n\t}\n\ttime.Sleep(5 * time.Millisecond)\n\tif _, err := s.Collect(); err == nil { t.Fatal(\"interrupted collection unexpectedly succeeded\") }\n\ts.debugCrash = true\n\ts.Close()\n\n\ts2, err := Open(dir, &Options{MinAge: time.Millisecond})\n\tif err != nil { t.Fatal(err) }\n\tdefer s2.Close()\n\tif !s2.Has(root) || !s2.Has(leaf) { t.Fatal(\"reachable root tree lost on Open\") }\n\treplayed := 0\n\tfor _, id := range garbage { if !s2.Has(id) { replayed++ } }\n\tif replayed == 0 { t.Fatal(\"Open replayed no journaled deletions\") }\n\tevs, err := s2.Collect()\n\tif err != nil { t.Fatal(err) }\n\tfor _, id := range garbage { if s2.Has(id) { t.Fatalf(\"garbage survived recovery and follow-up GC: %s\", id) } }\n\tif !s2.Has(root) || !s2.Has(leaf) { t.Fatal(\"follow-up GC deleted reachable tree\") }\n\tfor _, ev := range evs { if ev.Reason == \"\" { t.Fatal(\"follow-up deletion lacks evidence\") } }\n\tt.Logf(\"recovered_deletions=%d remaining_garbage_removed=%d reachable_tree_preserved=true evidence=%d\", replayed, 3-replayed, len(evs))\n}\n"

B 探针完整输入文件 run_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nimport shutil\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nSUPPORT = Path(__file__).resolve().parent\nDEST = SUPPORT / \"probe-workspace\"\nGO = \"/usr/local/go/bin/go\"\n\ndef prepare():\n    workspace = Path(sys.argv[2]).resolve()\n    if DEST.exists():\n        shutil.rmtree(DEST)\n    DEST.mkdir()\n    for name in (\"go.mod\", \"store.go\", \"gc.go\", \"journal.go\"):\n        shutil.copy2(workspace / name, DEST / name)\n    for name in (\"probe_recovery_test.go\", \"probe_barrier_test.go\"):\n        shutil.copy2(SUPPORT / name, DEST / name)\n\ndef main():\n    action = sys.argv[1]\n    if action == \"prepare\":\n        prepare()\n        print(\"isolated_probe_copy_ready\")\n        return 0\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(SUPPORT / \".gocache\")\n    if action == \"warmup\":\n        result = subprocess.run(\n            [GO, \"test\", \"-run\", \"^$\"], cwd=DEST, env=env,\n            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n        )\n        print(result.stdout, end=\"\")\n        return result.returncode\n    names = {\n        \"recovery\": \"TestProbeStartupRecovery\",\n        \"barrier\": \"TestProbeAfterMarkRootBarrier\",\n    }\n    test = names[action]\n    result = subprocess.run(\n        [GO, \"test\", \"-v\", \"-count=1\", \"-run\", \"^\" + test + \"$\"],\n        cwd=DEST, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n    )\n    print(result.stdout, end=\"\")\n    return result.returncode\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/judge/pair/attempt-001/demonstration-B/demonstration/run_probe.py recovery\n=== RUN   TestProbeStartupRecovery\n    probe_recovery_test.go:49: recovered_deletions=1 remaining_garbage_removed=2 reachable_tree_preserved=true evidence=2\n--- PASS: TestProbeStartupRecovery (0.01s)\nPASS\nok  \tobjstore\t0.010s\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/e84525a91ffe43829303652a69bfaa3c/judge/pair/attempt-001/demonstration-B/demonstration/run_probe.py barrier\n=== RUN   TestProbeAfterMarkRootBarrier\n    probe_barrier_test.go:38: late_root_survived=true expired_garbage_removed=true evidence_matches=1\n--- PASS: TestProbeAfterMarkRootBarrier (0.00s)\nPASS\nok  \tobjstore\t0.004s\n"
