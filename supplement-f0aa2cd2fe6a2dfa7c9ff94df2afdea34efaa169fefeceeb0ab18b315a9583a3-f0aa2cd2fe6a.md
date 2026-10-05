

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：3c270a175dfeea59e8e4579f4922a47d09036db2

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tdedup\t1.065s\n"

A 预热命令：/usr/bin/node '{support}/run.mjs' '{workspace}' warmup race

A 检查：并发保存与消费
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestAssistConcurrentSnapshot$' race
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package dedup\nimport(\"fmt\";\"path/filepath\";\"sync\";\"testing\")\nfunc TestAssistConcurrentSnapshot(t *testing.T){s,_:=Open(filepath.Join(t.TempDir(),\"snapshot.json\"),100);for i:=0;i<100;i++{s.Ingest(Event{Key:fmt.Sprint(i),EventTime:100,Payload:[]byte(\"x\")})};var wg sync.WaitGroup;wg.Add(2);start:=make(chan struct{});go func(){defer wg.Done();<-start;for i:=0;i<3000;i++{s.Ingest(Event{Key:fmt.Sprint(i%200),EventTime:100,Payload:[]byte(\"x\")})}}();go func(){defer wg.Done();<-start;for i:=0;i<200;i++{if err:=s.Save();err!=nil{t.Error(err)}}}();close(start);wg.Wait()}\n"

A 探针完整输入文件 run.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';\nconst sup=path.dirname(fileURLToPath(import.meta.url)),ws=process.argv[2],mode=process.argv[3];\nconst config=JSON.parse(fs.readFileSync(path.join(sup,'go-files.json'))),replace={};\nfor(const [name,rel] of Object.entries(config))replace[path.join(ws,rel)]=path.join(sup,name);\nconst overlay=path.join(sup,'overlay.json');fs.writeFileSync(overlay,JSON.stringify({Replace:replace}));\nconst args=['-C',path.join(ws,''),'test','-overlay',overlay,'-count=1','-v','-run',mode==='warmup'?'^$':mode];\nif(process.argv[4]==='race')args.push('-race');args.push('./...');\nconst r=spawnSync('/usr/local/bin/go',args,{encoding:'utf8',env:{...process.env,GOCACHE:path.join(sup,'gocache')},timeout:110000,maxBuffer:8*1024*1024});\nconst output=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(sup,'last-'+(mode==='warmup'?'warmup':'probe')+'.log'),output);\nif(r.error)throw r.error;console.log(output.trim().split('\\n').slice(-13).join('\\n'));console.log('raceDetected='+output.includes('WARNING: DATA RACE'));console.log('go exit='+r.status);process.exit(r.status??1);\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/judge/pair/attempt-004/demonstration-A/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/record/A/attempt-001/workspace '^TestAssistConcurrentSnapshot$' race\nGoroutine 9 (running) created at:\n  dedup.TestAssistConcurrentSnapshot()\n      /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/record/A/attempt-001/workspace/probe_assist_test.go:3 +0x46a\n  testing.tRunner()\n      /usr/local/go/src/testing/testing.go:2193 +0x21c\n  testing.(*T).Run.gowrap1()\n      /usr/local/go/src/testing/testing.go:2258 +0x38\n==================\n    testing.go:1865: race detected during execution of test\n--- FAIL: TestAssistConcurrentSnapshot (1.58s)\nFAIL\nFAIL\tdedup\t1.625s\nFAIL\nraceDetected=true\ngo exit=1\n"

B 产物提交：cf95004fe71993cbcb509432264d34798c2fd968

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tdedup\t1.419s\n"

B 预热命令：/usr/bin/node '{support}/run.mjs' '{workspace}' warmup

B 检查：重启后的窗口去重
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestAssistRestart$'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package dedup\nimport(\"bytes\";\"testing\")\nfunc TestAssistRestart(t *testing.T){s,_:=New(10);s.Ingest(Event{Key:\"old\",Time:100,Payload:[]byte(\"old\")});s.Ingest(Event{Key:\"live\",Time:112,Payload:[]byte(\"p\")});var b bytes.Buffer;if err:=s.Snapshot(&b);err!=nil{t.Fatal(err)};r,err:=Restore(&b);if err!=nil{t.Fatal(err)};dup:=r.Ingest(Event{Key:\"live\",Time:112,Payload:[]byte(\"p\")});conflict:=r.Ingest(Event{Key:\"live\",Time:112,Payload:[]byte(\"other\")});late:=r.Ingest(Event{Key:\"old\",Time:100,Payload:[]byte(\"old\")});t.Logf(\"restart duplicate=%v conflict=%v evictedReplay=%v\",dup,conflict,late);if dup!=ResultDuplicate||conflict!=ResultConflict||late!=ResultLate{t.Fatal(\"decisions changed\")}}\n"

B 探针完整输入文件 run.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';\nconst sup=path.dirname(fileURLToPath(import.meta.url)),ws=process.argv[2],mode=process.argv[3];\nconst config=JSON.parse(fs.readFileSync(path.join(sup,'go-files.json'))),replace={};\nfor(const [name,rel] of Object.entries(config))replace[path.join(ws,rel)]=path.join(sup,name);\nconst overlay=path.join(sup,'overlay.json');fs.writeFileSync(overlay,JSON.stringify({Replace:replace}));\nconst args=['-C',path.join(ws,''),'test','-overlay',overlay,'-count=1','-v','-run',mode==='warmup'?'^$':mode];\nif(process.argv[4]==='race')args.push('-race');args.push('./...');\nconst r=spawnSync('/usr/local/bin/go',args,{encoding:'utf8',env:{...process.env,GOCACHE:path.join(sup,'gocache')},timeout:110000,maxBuffer:8*1024*1024});\nconst output=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(sup,'last-'+(mode==='warmup'?'warmup':'probe')+'.log'),output);\nif(r.error)throw r.error;console.log(output.trim().split('\\n').slice(-13).join('\\n'));console.log('raceDetected='+output.includes('WARNING: DATA RACE'));console.log('go exit='+r.status);process.exit(r.status??1);\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/judge/pair/attempt-004/demonstration-B/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/5d18f001826e48b08679352f5d0ecf0b/record/B/attempt-001/workspace '^TestAssistRestart$'\n=== RUN   TestAssistRestart\n    probe_assist_test.go:3: restart duplicate=Duplicate conflict=Conflict evictedReplay=Late\n--- PASS: TestAssistRestart (0.00s)\nPASS\nok  \tdedup\t0.013s\nraceDetected=false\ngo exit=0\n"
