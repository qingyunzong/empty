

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：82b63d823cf72922e15424b515ac0fb665fbce07

A 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/verify/A/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \texample.com/poly\t1.195s\n"

A 预热命令：python3 '{support}/probe.py' '{workspace}' prepare

A 检查：验证高指数幂
复现命令：python3 '{support}/probe.py' '{workspace}' exponent

A 检查：验证预算降级截断
复现命令：python3 '{support}/probe.py' '{workspace}' budget
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 budget_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestInheritedBudgetProbe(t *testing.T) {\n\tp := NewSym(2).Add(Var(0), Var(1))\n\tif p.NumTerms() != 2 || p.Uncertain() {\n\t\tt.Fatalf(\"setup polynomial has %d terms, uncertain=%v; want two exact terms\", p.NumTerms(), p.Uncertain())\n\t}\n\tlimited := NewSym(1).Add(p, Zero())\n\tt.Logf(\"Add result: terms=%d uncertain=%v polynomial=%s\", limited.NumTerms(), limited.Uncertain(), limited)\n\tif limited.NumTerms() != 1 || !limited.Uncertain() {\n\t\tt.Fatalf(\"budget 1 result has %d terms, uncertain=%v; want one marked partial term\", limited.NumTerms(), limited.Uncertain())\n\t}\n}\n"

A 探针完整输入文件 exponent_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestExponentRangeProbe(t *testing.T) {\n\tp := NewSym(1).Pow(Var(0), 65536)\n\tterms := p.Terms()\n\tif len(terms) != 1 || int(terms[0].Mono[0]) != 65536 {\n\t\tt.Fatalf(\"x^65536 became %s with exponent vector %v; want exponent 65536\", p.String(), terms[0].Mono)\n\t}\n}\n"

A 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport os\nimport pathlib\nimport shutil\nimport subprocess\nimport sys\n\nsupport = pathlib.Path(__file__).resolve().parent\nworkspace = pathlib.Path(sys.argv[1]).resolve()\nmode = sys.argv[2]\nstage = support / \"probe-work\"\ncache = support / \"gocache\"\ngo = \"/usr/local/go/bin/go\"\n\ndef run(args, expect=None):\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(cache)\n    try:\n        p = subprocess.run(args, cwd=stage, env=env, text=True, stdout=subprocess.PIPE,\n                           stderr=subprocess.STDOUT, timeout=45)\n    except subprocess.TimeoutExpired:\n        print(\"probe timed out\")\n        return 124\n    if mode == \"prepare\":\n        print(f\"prepare exit={p.returncode}\")\n        if p.stdout.strip():\n            print(p.stdout.strip())\n    else:\n        print(p.stdout.rstrip())\n    if expect is not None:\n        if p.returncode != expect:\n            print(f\"unexpected exit={p.returncode}, want={expect}\")\n            return 2\n        return p.returncode\n    return p.returncode\n\nif mode == \"prepare\":\n    if stage.exists():\n        shutil.rmtree(stage)\n    stage.mkdir(parents=True)\n    for name in (\"go.mod\", \"poly.go\"):\n        shutil.copy2(workspace / name, stage / name)\n    shutil.copy2(support / \"exponent_test.go\", stage / \"exponent_probe_test.go\")\n    shutil.copy2(support / \"budget_test.go\", stage / \"budget_probe_test.go\")\n    for pattern in (\"^$\",):\n        code = run([go, \"test\", \"-run\", pattern, \"-count=1\", \"./...\"], expect=0)\n        if code:\n            sys.exit(code)\nelif mode == \"exponent\":\n    sys.exit(run([go, \"test\", \"-run\", \"^TestExponentRangeProbe$\", \"-count=1\", \"-v\"], expect=1))\nelif mode == \"budget\":\n    sys.exit(run([go, \"test\", \"-run\", \"^TestInheritedBudgetProbe$\", \"-count=1\", \"-v\"], expect=0))\nelse:\n    print(\"usage: probe.py WORKSPACE prepare|exponent|budget\")\n    sys.exit(2)\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-A/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/record/A/attempt-001/workspace exponent\n=== RUN   TestExponentRangeProbe\n    exponent_probe_test.go:9: x^65536 became 1 with exponent vector [0 0 0 0 0]; want exponent 65536\n--- FAIL: TestExponentRangeProbe (0.00s)\nFAIL\nexit status 1\nFAIL\texample.com/poly\t0.010s\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-A/demonstration/probe.py /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/record/A/attempt-001/workspace budget\n=== RUN   TestInheritedBudgetProbe\n    budget_probe_test.go:11: Add result: terms=1 uncertain=true polynomial=x1\n--- PASS: TestInheritedBudgetProbe (0.00s)\nPASS\nok  \texample.com/poly\t0.006s\n"

B 产物提交：e0efc3be5caa1cb15473b968add5060366417842

B 测试命令：/usr/local/go/bin/go -C /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/verify/B/attempt-001/workspace test -race -count=1 ./...
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："ok  \tpoly\t1.202s\n"

B 预热命令：python3 '{support}/run_probe.py' --warmup '{workspace}'

B 检查：高指数幂的指数保留
复现命令：python3 '{support}/run_probe.py' '{workspace}' '{support}/exponent_probe_test.go'

B 检查：Add 对已有结果执行预算检查
复现命令：python3 '{support}/run_probe.py' '{workspace}' '{support}/budget_probe_test.go'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 budget_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport (\n\t\"errors\"\n\t\"testing\"\n)\n\nfunc TestBehaviorProbe(t *testing.T) {\n\tp, err := Add(Var(0), Var(1), 2)\n\tif err != nil {\n\t\tt.Fatalf(\"setup Add error: %v\", err)\n\t}\n\tgot, err := Add(p, Zero(), 1)\n\tt.Logf(\"observed terms=%d err=%v\", got.NumTerms(), err)\n\tif !errors.Is(err, ErrBudgetExhausted) {\n\t\tt.Fatalf(\"want ErrBudgetExhausted when existing result exceeds budget\")\n\t}\n}\n"

B 探针完整输入文件 exponent_probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestBehaviorProbe(t *testing.T) {\n\tp, err := Pow(Var(0), 65536, 1)\n\tif err != nil {\n\t\tt.Fatalf(\"Pow error: %v\", err)\n\t}\n\tterms := p.Terms()\n\tif len(terms) == 0 {\n\t\tt.Fatalf(\"Pow produced no terms: %s\", p.String())\n\t}\n\tt.Logf(\"observed exponent=%d polynomial=%s\", terms[0].Exp[0], p.String())\n\tif len(terms) != 1 || terms[0].Exp[0] != 65536 {\n\t\tt.Fatalf(\"want one term with exponent 65536\")\n\t}\n}\n"

B 探针完整输入文件 run_probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\n\"\"\"Run an isolated Go behavior probe against a copy of the supplied workspace.\"\"\"\nimport os\nimport pathlib\nimport shutil\nimport subprocess\nimport sys\nimport tempfile\n\nGO = \"/usr/local/go/bin/go\"\n\n\ndef main():\n    if len(sys.argv) == 3 and sys.argv[1] == \"--warmup\":\n        workspace = pathlib.Path(sys.argv[2]).resolve()\n        support = pathlib.Path(__file__).resolve().parent\n        cache = support / \".gocache\"\n        cache.mkdir(exist_ok=True)\n        env = os.environ.copy()\n        env[\"GOCACHE\"] = str(cache)\n        result = subprocess.run([GO, \"-C\", str(workspace), \"build\", \"./...\"], env=env,\n                                text=True, stdout=subprocess.PIPE,\n                                stderr=subprocess.STDOUT, timeout=120)\n        if result.stdout:\n            print(result.stdout, end=\"\" if result.stdout.endswith(\"\\n\") else \"\\n\")\n        if result.returncode == 0:\n            print(\"build warmup passed\")\n        return result.returncode\n    if len(sys.argv) != 3:\n        print(\"usage: run_probe.py WORKSPACE TEST_FILE\", file=sys.stderr)\n        return 2\n    workspace = pathlib.Path(sys.argv[1]).resolve()\n    test_file = pathlib.Path(sys.argv[2]).resolve()\n    support = pathlib.Path(__file__).resolve().parent\n    cache = support / \".gocache\"\n    cache.mkdir(exist_ok=True)\n    env = os.environ.copy()\n    env[\"GOCACHE\"] = str(cache)\n\n    with tempfile.TemporaryDirectory(prefix=\"poly-probe-\") as temp:\n        target = pathlib.Path(temp)\n        for src in workspace.iterdir():\n            if src.is_file() and (src.name == \"go.mod\" or src.suffix == \".go\"):\n                if src.name.endswith(\"_test.go\"):\n                    continue\n                shutil.copy2(src, target / src.name)\n        shutil.copy2(test_file, target / \"behavior_probe_test.go\")\n        try:\n            result = subprocess.run(\n                [GO, \"-C\", str(target), \"test\", \"-count=1\", \"-v\", \"-run\", \"^TestBehaviorProbe$\", \"./...\"],\n                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,\n                timeout=45,\n            )\n        except subprocess.TimeoutExpired as exc:\n            output = exc.stdout or \"\"\n            if isinstance(output, bytes):\n                output = output.decode(errors=\"replace\")\n            print(output, end=\"\" if output.endswith(\"\\n\") else \"\\n\")\n            print(\"probe timed out\")\n            return 124\n        print(result.stdout, end=\"\" if result.stdout.endswith(\"\\n\") else \"\\n\")\n        return result.returncode\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-B/demonstration/run_probe.py /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/record/B/attempt-001/workspace /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-B/demonstration/exponent_probe_test.go\n=== RUN   TestBehaviorProbe\n    behavior_probe_test.go:14: observed exponent=65536 polynomial=x^65536\n--- PASS: TestBehaviorProbe (0.00s)\nPASS\nok  \tpoly\t0.008s\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-B/demonstration/run_probe.py /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/record/B/attempt-001/workspace /home/delin/.local/share/gsb-workbench/artifacts/3cd198d6fbba4f35836b110531e93313/judge/pair/attempt-001/demonstration-B/demonstration/budget_probe_test.go\n=== RUN   TestBehaviorProbe\n    behavior_probe_test.go:14: observed terms=2 err=<nil>\n    behavior_probe_test.go:16: want ErrBudgetExhausted when existing result exceeds budget\n--- FAIL: TestBehaviorProbe (0.00s)\nFAIL\nFAIL\tpoly\t0.006s\nFAIL\n"

补充探针完整输入文件 A-exponent-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestExponentRangeProbe(t *testing.T) {\n\tp := NewSym(1).Pow(Var(0), 65536)\n\tterms := p.Terms()\n\tif len(terms) != 1 || int(terms[0].Mono[0]) != 65536 {\n\t\tt.Fatalf(\"x^65536 became %s with exponent vector %v; want exponent 65536\", p.String(), terms[0].Mono)\n\t}\n}\n"

补充输出 A-exponent-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestExponentRangeProbe\n    review_probe_test.go:9: x^65536 became 1 with exponent vector [0 0 0 0 0]; want exponent 65536\n--- FAIL: TestExponentRangeProbe (0.00s)\nFAIL\nexit status 1\nFAIL\texample.com/poly\t0.004s\n\nEXIT_CODE=1\n"

补充探针完整输入文件 B-exponent-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestExponentRangeProbe(t *testing.T) {\n\tp, err := Pow(Var(0), 65536, 1)\n\tif err != nil {\n\t\tt.Fatalf(\"Pow returned error: %v\", err)\n\t}\n\tterms := p.Terms()\n\tif len(terms) != 1 || terms[0].Exp[0] != 65536 {\n\t\tt.Fatalf(\"x^65536 became %s with exponent vector %v; want exponent 65536\", p.String(), terms[0].Exp)\n\t}\n}\n"

补充输出 B-exponent-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestExponentRangeProbe\n--- PASS: TestExponentRangeProbe (0.00s)\nPASS\nok  \tpoly\t0.003s\n\nEXIT_CODE=0\n"

补充探针完整输入文件 A-budget-inherited-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport \"testing\"\n\nfunc TestInheritedBudgetProbe(t *testing.T) {\n\ts := NewSym(2)\n\tp := s.Add(Var(0), Var(1))\n\tlimited := NewSym(1).Add(p, Zero())\n\tif limited.NumTerms() != 1 || !limited.Uncertain() {\n\t\tt.Fatalf(\"budget 1 result has %d terms, uncertain=%v; want one marked partial term\", limited.NumTerms(), limited.Uncertain())\n\t}\n}\n"

补充输出 A-budget-inherited-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestInheritedBudgetProbe\n--- PASS: TestInheritedBudgetProbe (0.00s)\nPASS\nok  \texample.com/poly\t0.003s\n\nEXIT_CODE=0\n"

补充探针完整输入文件 B-budget-inherited-probe_test.go以 JSON 字符串记录，解码后可还原完整输入文件："package poly\n\nimport (\n\t\"errors\"\n\t\"testing\"\n)\n\nfunc TestInheritedBudgetProbe(t *testing.T) {\n\tp, err := Add(Var(0), Var(1), 2)\n\tif err != nil { t.Fatal(err) }\n\tlimited, err := Add(p, Zero(), 1)\n\tif !errors.Is(err, ErrBudgetExhausted) {\n\t\tt.Fatalf(\"budget 1 Add returned %d terms, err=%v; want ErrBudgetExhausted\", limited.NumTerms(), err)\n\t}\n}\n"

补充输出 B-budget-inherited-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："=== RUN   TestInheritedBudgetProbe\n    review_budget_test.go:13: budget 1 Add returned 2 terms, err=<nil>; want ErrBudgetExhausted\n--- FAIL: TestInheritedBudgetProbe (0.00s)\nFAIL\nexit status 1\nFAIL\tpoly\t0.003s\n\nEXIT_CODE=1\n"
