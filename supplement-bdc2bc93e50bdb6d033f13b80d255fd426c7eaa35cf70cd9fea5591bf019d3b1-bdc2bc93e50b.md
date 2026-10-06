

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：252cad8eb59a0ef9fb1ac10720d25f9d1dcf819f

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \ttaskpool\t2.557s\n"

A 检查：关闭后结果等待者退出
复现命令：/bin/bash '{support}/probe-close.sh' '{workspace}' '{support}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 main.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"context\"\n\t\"fmt\"\n\t\"time\"\n\n\t\"taskpool\"\n)\n\nfunc main() {\n\tp := taskpool.New(1)\n\tstarted := make(chan struct{})\n\ttk, err := p.Submit(context.Background(), func(ctx context.Context) (any, error) {\n\t\tclose(started)\n\t\t<-ctx.Done()\n\t\treturn \"finished\", ctx.Err()\n\t})\n\tif err != nil {\n\t\tfmt.Println(\"submitErr\", err)\n\t\treturn\n\t}\n\t<-started\n\tclaimDone := make(chan error, 1)\n\tgo func() {\n\t\t_, err := tk.Result(context.Background())\n\t\tclaimDone <- err\n\t}()\n\ttime.Sleep(30 * time.Millisecond)\n\tp.Close()\n\tselect {\n\tcase err := <-claimDone:\n\t\tfmt.Println(\"claimExited=true\")\n\t\tfmt.Printf(\"err=%v\\n\", err)\n\t\tfmt.Printf(\"state=%s\\n\", tk.State())\n\tcase <-time.After(400 * time.Millisecond):\n\t\tfmt.Println(\"claimExited=false\")\n\t\tfmt.Printf(\"state=%s\\n\", tk.State())\n\t}\n}\n"

A 探针完整输入文件 probe-close.sh以 JSON 字符串记录，解码后可还原完整输入文件："#!/bin/bash\nset -eu\nWS=\"$1\"\nSUP=\"$2\"\nTMP=$(mktemp -d)\ntrap 'rm -rf \"$TMP\"' EXIT\nMOD=$(awk '/^module /{print $2; exit}' \"$WS/go.mod\")\nGOV=$(awk '/^go /{print $2; exit}' \"$WS/go.mod\")\ncat > \"$TMP/go.mod\" << EOF\nmodule probe\n\ngo ${GOV}\n\nrequire ${MOD} v0.0.0\n\nreplace ${MOD} => ${WS}\nEOF\ncp \"$SUP/main.go\" \"$TMP/main.go\"\nexport GOCACHE=\"$SUP/.gocache\"\nexport GOTMPDIR=\"$TMP\"\nmkdir -p \"$GOCACHE\"\ncd \"$TMP\"\n/usr/local/bin/go run .\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /bin/bash /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/judge/pair/attempt-081/demonstration-A/demonstration/probe-close.sh /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/record/A/attempt-001/workspace /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/judge/pair/attempt-081/demonstration-A/demonstration\nclaimExited=true\nerr=context canceled\nstate=Claimed\n"

B 产物提交：5d6689eeaf0ffe1c2bf7b857be5290d98ca6b659

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \ttaskpool\t1.224s\n"

B 检查：关闭后结果等待者仍堵住
复现命令：/bin/bash '{support}/probe-close.sh' '{workspace}' '{support}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 main.go以 JSON 字符串记录，解码后可还原完整输入文件："package main\n\nimport (\n\t\"context\"\n\t\"fmt\"\n\t\"time\"\n\n\t\"taskpool\"\n)\n\nfunc main() {\n\tp := taskpool.New(1)\n\tstarted := make(chan struct{})\n\ttk, err := p.Submit(func(ctx context.Context) (any, error) {\n\t\tclose(started)\n\t\t<-ctx.Done()\n\t\treturn \"finished\", ctx.Err()\n\t})\n\tif err != nil {\n\t\tfmt.Println(\"submitErr\", err)\n\t\treturn\n\t}\n\t<-started\n\tclaimDone := make(chan error, 1)\n\tgo func() {\n\t\t_, cErr := tk.Claim()\n\t\tclaimDone <- cErr\n\t}()\n\ttime.Sleep(30 * time.Millisecond)\n\tp.Close()\n\tselect {\n\tcase err := <-claimDone:\n\t\tfmt.Println(\"claimExited=true\")\n\t\tfmt.Printf(\"err=%v\\n\", err)\n\t\tfmt.Printf(\"state=%s\\n\", tk.State())\n\tcase <-time.After(400 * time.Millisecond):\n\t\tfmt.Println(\"claimExited=false\")\n\t\tfmt.Printf(\"state=%s\\n\", tk.State())\n\t}\n}\n"

B 探针完整输入文件 probe-close.sh以 JSON 字符串记录，解码后可还原完整输入文件："#!/bin/bash\nset -eu\nWS=\"$1\"\nSUP=\"$2\"\nTMP=$(mktemp -d)\ntrap 'rm -rf \"$TMP\"' EXIT\nMOD=$(awk '/^module /{print $2; exit}' \"$WS/go.mod\")\nGOV=$(awk '/^go /{print $2; exit}' \"$WS/go.mod\")\ncat > \"$TMP/go.mod\" << EOF\nmodule probe\n\ngo ${GOV}\n\nrequire ${MOD} v0.0.0\n\nreplace ${MOD} => ${WS}\nEOF\ncp \"$SUP/main.go\" \"$TMP/main.go\"\nexport GOCACHE=\"$SUP/.gocache\"\nexport GOTMPDIR=\"$TMP\"\nmkdir -p \"$GOCACHE\"\ncd \"$TMP\"\n/usr/local/bin/go run .\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /bin/bash /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/judge/pair/attempt-081/demonstration-B/demonstration/probe-close.sh /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/record/B/attempt-001/workspace /home/delin/.local/share/gsb-workbench/artifacts/bfb24e3ff2d5413b8c14a0132d09c297/judge/pair/attempt-081/demonstration-B/demonstration\nclaimExited=false\nstate=Running\n"
