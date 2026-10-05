

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：6de344d3921dafac05e9a020c240245035794542

A 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："?   \tsimcheck/cmd/simcheck\t[no test files]\nok  \tsimcheck/sim\t1.278s\n"

A 预热命令：/usr/bin/node '{support}/run.mjs' '{workspace}' warmup

A 检查：快照必要状态
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestSnapshotCoversQueueAndRNG$'

A 检查：最早损坏跳点
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestFindMinimalDivergence$'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 run.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';\nconst sup=path.dirname(fileURLToPath(import.meta.url)),ws=process.argv[2],mode=process.argv[3];\nconst config=JSON.parse(fs.readFileSync(path.join(sup,'go-files.json'))),replace={};\nfor(const [name,rel] of Object.entries(config))replace[path.join(ws,rel)]=path.join(sup,name);\nconst overlay=path.join(sup,'overlay.json');fs.writeFileSync(overlay,JSON.stringify({Replace:replace}));\nconst args=['-C',path.join(ws,''),'test','-overlay',overlay,'-count=1','-v','-run',mode==='warmup'?'^$':mode];\nif(process.argv[4]==='race')args.push('-race');args.push('./...');\nconst r=spawnSync('/usr/local/bin/go',args,{encoding:'utf8',env:{...process.env,GOCACHE:path.join(sup,'gocache')},timeout:110000,maxBuffer:8*1024*1024});\nconst output=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(sup,'last-'+(mode==='warmup'?'warmup':'probe')+'.log'),output);\nif(r.error)throw r.error;console.log(output.trim().split('\\n').slice(-13).join('\\n'));console.log('raceDetected='+output.includes('WARNING: DATA RACE'));console.log('go exit='+r.status);process.exit(r.status??1);\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/judge/pair/attempt-003/demonstration-A/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/record/A/attempt-001/workspace '^TestSnapshotCoversQueueAndRNG$'\n?   \tsimcheck/cmd/simcheck\t[no test files]\n=== RUN   TestSnapshotCoversQueueAndRNG\n--- PASS: TestSnapshotCoversQueueAndRNG (0.00s)\nPASS\nok  \tsimcheck/sim\t0.027s\nraceDetected=false\ngo exit=0\n$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/judge/pair/attempt-003/demonstration-A/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/record/A/attempt-001/workspace '^TestFindMinimalDivergence$'\n?   \tsimcheck/cmd/simcheck\t[no test files]\n=== RUN   TestFindMinimalDivergence\n--- PASS: TestFindMinimalDivergence (0.00s)\nPASS\nok  \tsimcheck/sim\t0.014s\nraceDetected=false\ngo exit=0\n"

B 产物提交：1afad589d01691e66162dcca60e552a42a99f4fb

B 测试命令：/usr/local/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："?   \tsimreplay\t[no test files]\nok  \tsimreplay/sim\t3.093s\n"

B 预热命令：/usr/bin/node '{support}/run.mjs' '{workspace}' warmup

B 检查：二进制快照往返
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestSnapshotRoundTripResume$'

B 检查：多处损坏的最早分歧
复现命令：/usr/bin/node '{support}/run.mjs' '{workspace}' '^TestCheckerReports(MinimalDivergence|EarliestOfMultipleCorruptions)$'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 run.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';\nconst sup=path.dirname(fileURLToPath(import.meta.url)),ws=process.argv[2],mode=process.argv[3];\nconst config=JSON.parse(fs.readFileSync(path.join(sup,'go-files.json'))),replace={};\nfor(const [name,rel] of Object.entries(config))replace[path.join(ws,rel)]=path.join(sup,name);\nconst overlay=path.join(sup,'overlay.json');fs.writeFileSync(overlay,JSON.stringify({Replace:replace}));\nconst args=['-C',path.join(ws,''),'test','-overlay',overlay,'-count=1','-v','-run',mode==='warmup'?'^$':mode];\nif(process.argv[4]==='race')args.push('-race');args.push('./...');\nconst r=spawnSync('/usr/local/bin/go',args,{encoding:'utf8',env:{...process.env,GOCACHE:path.join(sup,'gocache')},timeout:110000,maxBuffer:8*1024*1024});\nconst output=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(sup,'last-'+(mode==='warmup'?'warmup':'probe')+'.log'),output);\nif(r.error)throw r.error;console.log(output.trim().split('\\n').slice(-13).join('\\n'));console.log('raceDetected='+output.includes('WARNING: DATA RACE'));console.log('go exit='+r.status);process.exit(r.status??1);\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/judge/pair/attempt-003/demonstration-B/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/record/B/attempt-001/workspace '^TestSnapshotRoundTripResume$'\n?   \tsimreplay\t[no test files]\n=== RUN   TestSnapshotRoundTripResume\n--- PASS: TestSnapshotRoundTripResume (0.00s)\nPASS\nok  \tsimreplay/sim\t0.019s\nraceDetected=false\ngo exit=0\n$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/judge/pair/attempt-003/demonstration-B/demonstration/run.mjs /home/delin/.local/share/gsb-workbench/artifacts/521f543cbab54f22bac66d0d1e4a9ec6/record/B/attempt-001/workspace '^TestCheckerReports(MinimalDivergence|EarliestOfMultipleCorruptions)$'\n?   \tsimreplay\t[no test files]\n=== RUN   TestCheckerReportsMinimalDivergence\n--- PASS: TestCheckerReportsMinimalDivergence (0.02s)\n=== RUN   TestCheckerReportsEarliestOfMultipleCorruptions\n--- PASS: TestCheckerReportsEarliestOfMultipleCorruptions (0.02s)\nPASS\nok  \tsimreplay/sim\t0.056s\nraceDetected=false\ngo exit=0\n"
