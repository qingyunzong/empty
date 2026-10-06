

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：079c3526ac563e67a86edced7adc605e5085667a

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \trsp\t1.016s\n"

A 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go test ./...

A 检查：响应文件中的分隔符
复现命令：/usr/bin/python3 '{support}/probe.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Run an isolated Go assertion against a copied snapshot of the product.\"\"\"\nimport pathlib\nimport shutil\nimport subprocess\nimport sys\nimport tempfile\n\n\nGO = \"/usr/local/go/bin/go\"\n\nTEST = r'''package rsp\n\nimport \"testing\"\n\nfunc TestProbeDoubleDashIsConsumed(t *testing.T) {\n\tfiles := MapFS{\n\t\tcanonical(\"/first.rsp\"): \"-a -- -b\",\n\t\tcanonical(\"/second.rsp\"): \"-c\",\n\t}\n\ttokens, err := Expand([]string{\"-top\", \"@/first.rsp\", \"@/second.rsp\"}, files)\n\tif err != nil {\n\t\tt.Fatalf(\"Expand: %v\", err)\n\t}\n\toptions, positional := SplitOptions(tokens)\n\tif len(options) != 2 || len(positional) == 0 || positional[0].Text == \"--\" {\n\t\tt.Fatalf(\"unexpected split: options=%q positional=%q\", Texts(options), Texts(positional))\n\t}\n}\n'''\n\n\ndef main():\n    if len(sys.argv) != 2:\n        print(\"usage: probe.py WORKSPACE\", file=sys.stderr)\n        return 2\n    workspace = pathlib.Path(sys.argv[1])\n    cache = pathlib.Path(__file__).resolve().parent / \"gocache\"\n    cache.mkdir(exist_ok=True)\n    with tempfile.TemporaryDirectory(prefix=\"rsp-probe-\") as temp:\n        target = pathlib.Path(temp)\n        for name in (\"go.mod\", \"rsp.go\", \"tokenize.go\"):\n            shutil.copy2(workspace / name, target / name)\n        (target / \"probe_test.go\").write_text(TEST, encoding=\"utf-8\")\n        try:\n            result = subprocess.run(\n                [GO, \"test\", \"-run\", \"^TestProbeDoubleDashIsConsumed$\", \"-count=1\", \"-v\", \".\"],\n                cwd=target,\n                env={**__import__(\"os\").environ, \"GOCACHE\": str(cache)},\n                text=True,\n                stdout=subprocess.PIPE,\n                stderr=subprocess.STDOUT,\n                timeout=45,\n                check=False,\n            )\n        except subprocess.TimeoutExpired as exc:\n            captured = exc.stdout or \"\"\n            if isinstance(captured, bytes):\n                captured = captured.decode(errors=\"replace\")\n            print(captured, end=\"\")\n            print(\"probe timed out\")\n            return 124\n        print(result.stdout, end=\"\")\n        return result.returncode\n\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/judge/pair/attempt-074/demonstration-A/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/record/A/attempt-001/workspace\n=== RUN   TestProbeDoubleDashIsConsumed\n    probe_test.go:16: unexpected split: options=[\"-top\" \"-a\"] positional=[\"--\" \"-b\" \"-c\"]\n--- FAIL: TestProbeDoubleDashIsConsumed (0.00s)\nFAIL\nFAIL\trsp\t0.003s\nFAIL\n"

B 产物提交：007ccbdca086a870ebf12ced3049bad1d9f07372

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \texample.com/rsp/rsp\t1.162s\n"

B 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/probe.go' split

B 检查：切分响应参数
复现命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/probe.go' split

B 检查：符号链接循环检测
复现命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/probe.go' symlink
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\t\"path/filepath\"\n\t\"strings\"\n\n\t\"example.com/rsp/rsp\"\n)\n\nfunc fail(format string, args ...any) {\n\tfmt.Fprintf(os.Stderr, \"FAIL: \"+format+\"\\n\", args...)\n\tos.Exit(1)\n}\n\nfunc main() {\n\tif len(os.Args) != 2 {\n\t\tfail(\"expected one probe name\")\n\t}\n\tswitch os.Args[1] {\n\tcase \"split\":\n\t\tfs := rsp.MapFS{Files: map[string]string{\n\t\t\t\"/outer.rsp\": \"-v -- @inner.rsp\",\n\t\t\t\"/inner.rsp\": \"tail\",\n\t\t}}\n\t\tgot, err := rsp.Parse(fs, []string{\"@outer.rsp\"})\n\t\tif err != nil {\n\t\t\tfail(\"Parse: %v\", err)\n\t\t}\n\t\toptions := texts(got.Options)\n\t\tpositional := texts(got.Positional)\n\t\tif !got.Terminated || strings.Join(options, \",\") != \"-v\" || strings.Join(positional, \",\") != \"tail\" {\n\t\t\tfail(\"options=%q positional=%q terminated=%t\", options, positional, got.Terminated)\n\t\t}\n\t\tfmt.Printf(\"PASS options=%q positional=%q terminated=%t\\n\", options, positional, got.Terminated)\n\tcase \"symlink\":\n\t\tdir, err := os.MkdirTemp(\"\", \"rsp-symlink-probe-\")\n\t\tif err != nil {\n\t\t\tfail(\"create temp dir: %v\", err)\n\t\t}\n\t\tdefer os.RemoveAll(dir)\n\t\treal := filepath.Join(dir, \"real\")\n\t\tif err := os.Mkdir(real, 0700); err != nil {\n\t\t\tfail(\"create response dir: %v\", err)\n\t\t}\n\t\tif err := os.WriteFile(filepath.Join(real, \"a.rsp\"), []byte(\"@link/b.rsp\"), 0600); err != nil {\n\t\t\tfail(\"write a.rsp: %v\", err)\n\t\t}\n\t\tif err := os.WriteFile(filepath.Join(real, \"b.rsp\"), []byte(\"@a.rsp\"), 0600); err != nil {\n\t\t\tfail(\"write b.rsp: %v\", err)\n\t\t}\n\t\tif err := os.Symlink(real, filepath.Join(real, \"link\")); err != nil {\n\t\t\tfail(\"create symlink: %v\", err)\n\t\t}\n\t\t_, err = rsp.Parse(rsp.OSFS{}, []string{\"@\" + filepath.Join(real, \"a.rsp\")})\n\t\tcycle, ok := err.(*rsp.CycleError)\n\t\tif !ok || len(cycle.Chain) != 3 || cycle.Chain[0] != cycle.Chain[2] {\n\t\t\tfail(\"expected canonical symlink cycle; got %T %v\", err, err)\n\t\t}\n\t\tfmt.Printf(\"PASS symlink-cycle chain-length=%d closed=%t\\n\", len(cycle.Chain), cycle.Chain[0] == cycle.Chain[2])\n\tdefault:\n\t\tfail(\"unknown probe %q\", os.Args[1])\n\t}\n}\n\nfunc texts(tokens []rsp.Token) []string {\n\tout := make([]string, len(tokens))\n\tfor i, token := range tokens {\n\t\tout[i] = token.Text\n\t}\n\treturn out\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/judge/pair/attempt-074/demonstration-B/demonstration/gocache /usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/record/B/attempt-001/workspace run /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/judge/pair/attempt-074/demonstration-B/demonstration/probe.go split\nPASS options=[\"-v\"] positional=[\"tail\"] terminated=true\n$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/judge/pair/attempt-074/demonstration-B/demonstration/gocache /usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/record/B/attempt-001/workspace run /home/delin/.local/share/gsb-workbench/artifacts/9b41f0eaa6144d12be6de0b2ae7bdec6/judge/pair/attempt-074/demonstration-B/demonstration/probe.go symlink\nPASS symlink-cycle chain-length=3 closed=true\n"
