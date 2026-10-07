

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：36afd165aadaf3f85728e88d172a17fc5f4df227

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：1
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："--- FAIL: TestWriteErrorPositionsByteAccounting (0.00s)\n    forwarder_test.go:322: failAt 0: published 5 off 5, want 2\nFAIL\nFAIL\tforward\t0.108s\nFAIL\n"

A 检查：EOF 与在途写失败
复现命令：/usr/bin/python3 '{support}/run.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 eof_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package forward\nimport(\"context\";\"errors\";\"fmt\";\"io\";\"testing\";\"time\")\ntype eofSource struct { n int; eof chan struct{} }\nfunc (s *eofSource) ReadChunk() ([]byte,error) {s.n++;if s.n==1{return []byte(\"aa\"),nil};close(s.eof);return nil,io.EOF}\nfunc (s *eofSource) Close() error{return nil}\ntype delayedSink struct {eof chan struct{}}\nfunc (s *delayedSink) Write(c *Chunk) error {defer c.Release();<-s.eof;time.Sleep(100*time.Millisecond);return errors.New(\"write boom\")}\nfunc (s *delayedSink) Close(error){}\n\nfunc TestWriteFailureAtEOF(t *testing.T) { falseSuccess:=0;other:=0;_ = other; for i:=0;i<10;i++ {src:=&eofSource{eof:make(chan struct{})};sink:=&delayedSink{eof:src.eof};r:=(&Forwarder{MaxBytes:100}).Forward(context.Background(),src,sink); if r.Outcome==Delivered&&r.Err==nil {falseSuccess++}};fmt.Printf(\"side=A attempts=10 false_success=%d other=%d\\n\",falseSuccess,other);if falseSuccess>0 {t.Fatalf(\"write failure was reported as delivered\")};if other>0 {t.Fatalf(\"write failure was not classified\")}}\n"

A 探针完整输入文件 run.py以 JSON 字符串记录，解码后可还原完整输入文件："import os,pathlib,shutil,subprocess,sys,tempfile\ns=pathlib.Path(__file__).parent\nw=pathlib.Path(sys.argv[1])\nwith tempfile.TemporaryDirectory(dir=s) as d:\n p=pathlib.Path(d)/\"product\"\n shutil.copytree(w,p,ignore=shutil.ignore_patterns(\".git\"))\n shutil.copy2(s/\"eof_probe_test.go\",p/\"eof_probe_test.go\")\n r=subprocess.run([\"/usr/local/go/bin/go\",\"test\",\"-run\",\"^TestWriteFailureAtEOF$\",\"-count=1\",\"-v\",\".\"],cwd=p,env={**os.environ,\"GOCACHE\":str(s/\".gocache\")},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)\n (s/\"latest-full.log\").write_text(r.stdout)\n print(r.stdout,end=\"\")\n sys.exit(r.returncode)\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/judge/pair/attempt-003/demonstration-A/demonstration/run.py /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/record/A/attempt-001/workspace\n=== RUN   TestWriteFailureAtEOF\nside=A attempts=10 false_success=10 other=0\n    eof_probe_test.go:10: write failure was reported as delivered\n--- FAIL: TestWriteFailureAtEOF (1.01s)\nFAIL\nFAIL\tforward\t1.009s\nFAIL\n"

B 产物提交：e3733a43b74d699ae1a8c64daa5d5d9282035860

B 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tforward\t1.104s\n"

B 检查：EOF 与在途写失败
复现命令：/usr/bin/python3 '{support}/run.py' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 eof_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package forward\nimport(\"context\";\"errors\";\"fmt\";\"io\";\"testing\";\"time\")\ntype eofSource struct { n int; eof chan struct{} }\nfunc (s *eofSource) ReadChunk(buf []byte) (int,error) {s.n++;if s.n==1 {copy(buf,[]byte(\"aa\"));return 2,nil};close(s.eof);return 0,io.EOF}\nfunc (s *eofSource) Close() error{return nil}\ntype delayedSink struct {eof chan struct{}}\nfunc (s *delayedSink) WriteChunk(ctx context.Context,data []byte) error {<-s.eof;time.Sleep(100*time.Millisecond);return errors.New(\"write boom\")}\nfunc (s *delayedSink) Close(error) error{return nil}\n\nfunc TestWriteFailureAtEOF(t *testing.T) { falseSuccess:=0;other:=0;_ = other; for i:=0;i<10;i++ {src:=&eofSource{eof:make(chan struct{})};sink:=&delayedSink{eof:src.eof};r:=New(Config{MaxBytes:100}).Forward(context.Background(),src,sink); if r.State==StateDelivered&&r.Err==nil {falseSuccess++};if r.State!=StateWriteFailed || r.Err==nil {other++}};fmt.Printf(\"side=B attempts=10 false_success=%d other=%d\\n\",falseSuccess,other);if falseSuccess>0 {t.Fatalf(\"write failure was reported as delivered\")};if other>0 {t.Fatalf(\"write failure was not classified\")}}\n"

B 探针完整输入文件 run.py以 JSON 字符串记录，解码后可还原完整输入文件："import os,pathlib,shutil,subprocess,sys,tempfile\ns=pathlib.Path(__file__).parent\nw=pathlib.Path(sys.argv[1])\nwith tempfile.TemporaryDirectory(dir=s) as d:\n p=pathlib.Path(d)/\"product\"\n shutil.copytree(w,p,ignore=shutil.ignore_patterns(\".git\"))\n shutil.copy2(s/\"eof_probe_test.go\",p/\"eof_probe_test.go\")\n r=subprocess.run([\"/usr/local/go/bin/go\",\"test\",\"-run\",\"^TestWriteFailureAtEOF$\",\"-count=1\",\"-v\",\".\"],cwd=p,env={**os.environ,\"GOCACHE\":str(s/\".gocache\")},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)\n (s/\"latest-full.log\").write_text(r.stdout)\n print(r.stdout,end=\"\")\n sys.exit(r.returncode)\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/python3 /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/judge/pair/attempt-003/demonstration-B/demonstration/run.py /home/delin/.local/share/gsb-workbench/artifacts/b42517ff9f7943d49d83fe027e1191e7/record/B/attempt-001/workspace\n=== RUN   TestWriteFailureAtEOF\nside=B attempts=10 false_success=0 other=0\n--- PASS: TestWriteFailureAtEOF (1.01s)\nPASS\nok  \tforward\t1.009s\n"

补充探针完整输入文件 A-eof-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package forward\nimport(\"context\";\"errors\";\"fmt\";\"io\";\"testing\";\"time\")\ntype eofSource struct { n int; eof chan struct{} }\nfunc (s *eofSource) ReadChunk() ([]byte,error) {s.n++;if s.n==1{return []byte(\"aa\"),nil};close(s.eof);return nil,io.EOF}\nfunc (s *eofSource) Close() error{return nil}\ntype delayedSink struct {eof chan struct{}}\nfunc (s *delayedSink) Write(c *Chunk) error {defer c.Release();<-s.eof;time.Sleep(100*time.Millisecond);return errors.New(\"write boom\")}\nfunc (s *delayedSink) Close(error){}\n\nfunc TestWriteFailureAtEOF(t *testing.T) { falseSuccess:=0;other:=0;_ = other; for i:=0;i<10;i++ {src:=&eofSource{eof:make(chan struct{})};sink:=&delayedSink{eof:src.eof};r:=(&Forwarder{MaxBytes:100}).Forward(context.Background(),src,sink); if r.Outcome==Delivered&&r.Err==nil {falseSuccess++}};fmt.Printf(\"side=A attempts=10 false_success=%d other=%d\\n\",falseSuccess,other);if falseSuccess>0 {t.Fatalf(\"write failure was reported as delivered\")};if other>0 {t.Fatalf(\"write failure was not classified\")}}\n"

补充输出 A-eof-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestWriteFailureAtEOF\nside=A attempts=10 false_success=10 other=0\n    eof_probe_test.go:10: write failure was reported as delivered\n--- FAIL: TestWriteFailureAtEOF (1.01s)\nFAIL\nFAIL\tforward\t1.014s\nFAIL\n"

补充探针完整输入文件 B-eof-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package forward\nimport(\"context\";\"errors\";\"fmt\";\"io\";\"testing\";\"time\")\ntype eofSource struct { n int; eof chan struct{} }\nfunc (s *eofSource) ReadChunk(buf []byte) (int,error) {s.n++;if s.n==1 {copy(buf,[]byte(\"aa\"));return 2,nil};close(s.eof);return 0,io.EOF}\nfunc (s *eofSource) Close() error{return nil}\ntype delayedSink struct {eof chan struct{}}\nfunc (s *delayedSink) WriteChunk(ctx context.Context,data []byte) error {<-s.eof;time.Sleep(100*time.Millisecond);return errors.New(\"write boom\")}\nfunc (s *delayedSink) Close(error) error{return nil}\n\nfunc TestWriteFailureAtEOF(t *testing.T) { falseSuccess:=0;other:=0;_ = other; for i:=0;i<10;i++ {src:=&eofSource{eof:make(chan struct{})};sink:=&delayedSink{eof:src.eof};r:=New(Config{MaxBytes:100}).Forward(context.Background(),src,sink); if r.State==StateDelivered&&r.Err==nil {falseSuccess++};if r.State!=StateWriteFailed || r.Err==nil {other++}};fmt.Printf(\"side=B attempts=10 false_success=%d other=%d\\n\",falseSuccess,other);if falseSuccess>0 {t.Fatalf(\"write failure was reported as delivered\")};if other>0 {t.Fatalf(\"write failure was not classified\")}}\n"

补充输出 B-eof-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestWriteFailureAtEOF\nside=B attempts=10 false_success=0 other=0\n--- PASS: TestWriteFailureAtEOF (1.01s)\nPASS\nok  \tforward\t1.011s\n"
