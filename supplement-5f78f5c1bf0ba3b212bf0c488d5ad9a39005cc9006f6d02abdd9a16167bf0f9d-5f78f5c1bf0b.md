

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：e1c3d63dfe028ea68c91c234d10e819acaca5632

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tcmdwrap/cmdwrap\t4.661s\n"

A 预热命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/probe.go'

A 检查：默认输出上限与管道排空
复现命令：env 'GOCACHE={support}/.gocache' /usr/local/go/bin/go -C '{workspace}' run '{support}/probe.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"context\"\n\t\"fmt\"\n\t\"os\"\n\t\"strconv\"\n\t\"time\"\n\n\t\"cmdwrap/cmdwrap\"\n)\n\nfunc main() {\n\tconst total = 4 << 20\n\tconst limit = 1 << 20\n\tcode := \"import sys; n=int(sys.argv[1]); sys.stdout.buffer.write(b'o'*n); sys.stderr.buffer.write(b'e'*n)\"\n\tresult := cmdwrap.Run(context.Background(), cmdwrap.Options{\n\t\tName: \"python3\",\n\t\tArgs: []string{\"-c\", code, strconv.Itoa(total)},\n\t\tTimeout: 10 * time.Second,\n\t})\n\tif result.ExitCode != 0 || result.Success() != true {\n\t\tfmt.Fprintf(os.Stderr, \"probe failed: exit=%d success=%v state=%v\\n\", result.ExitCode, result.Success(), result.State)\n\t\tos.Exit(1)\n\t}\n\tif len(result.Stdout) != limit || len(result.Stderr) != limit || !result.StdoutTruncated || !result.StderrTruncated {\n\t\tfmt.Fprintf(os.Stderr, \"probe failed: stdout=%d/%v stderr=%d/%v\\n\", len(result.Stdout), result.StdoutTruncated, len(result.Stderr), result.StderrTruncated)\n\t\tos.Exit(1)\n\t}\n\tfmt.Printf(\"exit=%d success=%v stdout=%d/%d truncated=%v stderr=%d/%d truncated=%v\\n\",\n\t\tresult.ExitCode, result.Success(), len(result.Stdout), limit, result.StdoutTruncated,\n\t\tlen(result.Stderr), limit, result.StderrTruncated)\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/judge/pair/attempt-001/demonstration-A/demonstration/.gocache /usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/record/A/attempt-001/workspace run /home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/judge/pair/attempt-001/demonstration-A/demonstration/probe.go\nexit=0 success=true stdout=1048576/1048576 truncated=true stderr=1048576/1048576 truncated=true\n"

B 产物提交：4fc1ea5e30e8eda0fceafe1891e9ad330c67c762

B 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tcmdwrap\t3.637s\n"

B 预热命令：/usr/local/go/bin/go version

B 预热命令：/usr/bin/env 'GOCACHE={support}/gocache' /usr/local/go/bin/go build -o '{support}/probe' '{support}/probe.go'

B 检查：零值输出上限
复现命令：/usr/bin/env 'GOCACHE={support}/gocache' '{support}/probe'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"context\"\n\t\"fmt\"\n\t\"os\"\n\n\t\"cmdwrap\"\n)\n\nfunc main() {\n\tconst want = 4 << 20\n\tcode := fmt.Sprintf(\"import os; n=%d; chunk=b'x'*65536; left=n;\\nwhile left:\\n k=min(left,len(chunk)); os.write(1,chunk[:k]); os.write(2,chunk[:k]); left-=k\", want)\n\tres := cmdwrap.Run(context.Background(), cmdwrap.Options{}, \"python3\", \"-c\", code)\n\tif !res.Success {\n\t\tfmt.Fprintf(os.Stderr, \"probe failed: child success=%v exit=%d err=%v\\n\", res.Success, res.ExitCode, res.Err)\n\t\tos.Exit(2)\n\t}\n\tfmt.Printf(\"captured stdout=%d stderr=%d bytes; truncated stdout=%t stderr=%t\\n\", len(res.Stdout), len(res.Stderr), res.StdoutTruncated, res.StderrTruncated)\n\tif len(res.Stdout) != want || len(res.Stderr) != want || res.StdoutTruncated || res.StderrTruncated {\n\t\tfmt.Fprintln(os.Stderr, \"probe did not observe uncapped zero-value capture\")\n\t\tos.Exit(1)\n\t}\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/env GOCACHE=/home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/judge/pair/attempt-001/demonstration-B/demonstration/gocache /home/delin/.local/share/gsb-workbench/artifacts/efd23188003b4f8eb360bf570521ab18/judge/pair/attempt-001/demonstration-B/demonstration/probe\ncaptured stdout=4194304 stderr=4194304 bytes; truncated stdout=false stderr=false\n"
