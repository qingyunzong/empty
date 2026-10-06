

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：7770f87f48995190f8ae1ebdf374bdba3cefa29f

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tchansim\t6.033s\n"

A 检查：无缓冲幽灵发送
复现命令：bash '{support}/probe.sh' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.sh以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env bash\nset -euo pipefail\nWS=\"$1\"\nexport GOCACHE=\"${GOCACHE:-/tmp/gocache-assist}\"\nTMP=$(mktemp -d)\ntrap 'rm -rf \"$TMP\"' EXIT\ncat > \"$TMP/go.mod\" <<EOF\nmodule example.com/probe\ngo 1.22\nrequire chansim v0.0.0\nreplace chansim => $WS\nEOF\ncat > \"$TMP/main.go\" <<'EOF'\npackage main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\t\"runtime\"\n\t\"time\"\n\t\"chansim\"\n)\n\nfunc once() (hit bool, detail string) {\n\tc := chansim.New(0)\n\tdone := make(chan string, 1)\n\tgo func() {\n\t\ttime.Sleep(20 * time.Millisecond)\n\t\tok1 := c.Send(1)\n\t\tok2 := c.Send(2)\n\t\tdone <- fmt.Sprintf(\"sends ok1=%v ok2=%v len=%d\", ok1, ok2, c.Len())\n\t}()\n\tv, ok := c.Recv()\n\tmsg := <-done\n\tv2, ok2 := c.TryRecv()\n\tdetail = fmt.Sprintf(\"recv=%v/%v %s leftover=%v/%v len=%d\", v, ok, msg, v2, ok2, c.Len())\n\treturn ok2 || c.Len() > 0 || (contains(msg, \"ok2=true\") && contains(msg, \"len=2\")), detail\n}\n\nfunc contains(s, sub string) bool {\n\treturn len(sub) == 0 || search(s, sub)\n}\nfunc search(s, sub string) bool {\n\tfor i := 0; i+len(sub) <= len(s); i++ {\n\t\tif s[i:i+len(sub)] == sub {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n\nfunc main() {\n\truntime.GOMAXPROCS(1)\n\tfor trial := 1; trial <= 300; trial++ {\n\t\thit, detail := once()\n\t\tif hit {\n\t\t\tfmt.Printf(\"trial=%d %s\\n\", trial, detail)\n\t\t\tfmt.Println(\"ghost-send-detected\")\n\t\t\tos.Exit(1)\n\t\t}\n\t}\n\tfmt.Println(\"ghost-not-seen-in-300\")\n\tos.Exit(1)\n}\nEOF\ncd \"$TMP\"\ngo mod tidy >/dev/null\ngo run ."

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ bash /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/judge/pair/attempt-085/demonstration-A/demonstration/probe.sh /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/record/A/attempt-001/workspace\ntrial=1 recv=1/true sends ok1=true ok2=true len=2 leftover=2/true len=0\nghost-send-detected\nexit status 1\n"

B 产物提交：784118cd46004b7f6cd10f37a2db5c41d704d657

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：127
完整输出以 JSON 字符串记录，解码后可还原完整原始输出：""

B 检查：关闭发送抢占 Select
复现命令：bash '{support}/probe.sh' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.sh以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env bash\nset -euo pipefail\nWS=\"$1\"\nexport GOCACHE=\"${GOCACHE:-/tmp/gocache-assist}\"\nTMP=$(mktemp -d)\ntrap 'rm -rf \"$TMP\"' EXIT\ncat > \"$TMP/go.mod\" <<EOF\nmodule example.com/probe\ngo 1.22\nrequire chansim v0.0.0\nreplace chansim => $WS\nEOF\ncat > \"$TMP/main.go\" <<'EOF'\npackage main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n\t\"time\"\n\t\"chansim\"\n)\n\nfunc main() {\n\topen := chansim.New(0)\n\tclosed := chansim.New(1)\n\tclosed.Close()\n\tdone := make(chan string, 1)\n\tgo func() {\n\t\tidx, val, ok := chansim.Select(chansim.Recv(open), chansim.Send(closed, 9))\n\t\tdone <- fmt.Sprintf(\"idx=%d val=%v ok=%v\", idx, val, ok)\n\t}()\n\tselect {\n\tcase s := <-done:\n\t\tfmt.Println(\"select-result\", s)\n\t\tif s == \"idx=1 val=<nil> ok=false\" {\n\t\t\tfmt.Println(\"closed-send-preempted-select\")\n\t\t\tos.Exit(1)\n\t\t}\n\t\tfmt.Println(\"unexpected-immediate\", s)\n\t\tos.Exit(1)\n\tcase <-time.After(200 * time.Millisecond):\n\t\tfmt.Println(\"blocked-waiting-for-open-recv\")\n\t\tgo func() { open.Send(1) }()\n\t\tfmt.Println(\"after-unblock\", <-done)\n\t}\n}\nEOF\ncd \"$TMP\"\ngo mod tidy >/dev/null\ngo run ."

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ bash /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/judge/pair/attempt-085/demonstration-B/demonstration/probe.sh /home/delin/.local/share/gsb-workbench/artifacts/727ef13bfe7c4f49a41f9c99af4efbca/record/B/attempt-001/workspace\nselect-result idx=1 val=<nil> ok=false\nclosed-send-preempted-select\nexit status 1\n"
