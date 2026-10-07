

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：3c6638ad1fe71f68d71a0c651fbac37313b23bce
A 没有实际执行的测试命令，不据此声称测试通过。

A 预热命令：g++ -std=c++20 '-I{workspace}/include' '{support}/probe_slice.cpp' -o '{support}/probe_slice'

A 预热命令：g++ -std=c++20 '-I{workspace}/include' '{support}/probe_bool_width.cpp' -o '{support}/probe_bool_width'

A 预热命令：g++ -std=c++20 '-I{workspace}/include' '{support}/probe_truncation.cpp' -o '{support}/probe_truncation'

A 检查：窄切片宽度
复现命令：'{support}/probe_slice'

A 检查：比较和逻辑结果宽度
复现命令：'{support}/probe_bool_width'

A 检查：超宽寄存器输入
复现命令：'{support}/probe_truncation'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe_bool_width.cpp以 JSON 字符串记录，解码后可还原完整输入文件："#include <rex/parser.hpp>\n\n#include <iostream>\n#include <vector>\n\nint main() {\n  const std::vector<rex::RegDecl> regs{{\"r0\", 8}, {\"r1\", 8}};\n  const auto comparison = rex::Parser(\"r0 == r1\", regs).parse();\n  const auto logical = rex::Parser(\"r0 && r1\", regs).parse();\n  std::cout << \"comparison_width=\" << unsigned(comparison.width)\n            << \" logical_width=\" << unsigned(logical.width) << '\\n';\n  if (comparison.width < 8 || logical.width < 8)\n    return 1;\n  return 0;\n}\n"

A 探针完整输入文件 probe_slice.cpp以 JSON 字符串记录，解码后可还原完整输入文件："#include <rex/parser.hpp>\n\n#include <iostream>\n#include <vector>\n\nint main() {\n  const std::vector<rex::RegDecl> regs{{\"r0\", 8}};\n  const auto expr = rex::Parser(\"r0[0:0]\", regs).parse();\n  std::cout << \"expression=r0[0:0] width=\" << unsigned(expr.width) << '\\n';\n  if (expr.width < 8)\n    return 1;\n  return 0;\n}\n"

A 探针完整输入文件 probe_truncation.cpp以 JSON 字符串记录，解码后可还原完整输入文件："#include <rex/rex.hpp>\n\n#include <iostream>\n#include <vector>\n\nint main() {\n  const std::vector<rex::RegDecl> decls{{\"r0\", 8}};\n  auto regs = rex::RegFile::from_decls(decls);\n  constexpr uint64_t supplied = 0x1ff;\n  regs.write(\"r0\", supplied);\n  const auto result = rex::eval(rex::Parser(\"r0\", decls).parse(), regs);\n  const auto* value = std::get_if<rex::Value>(&result);\n  if (!value) {\n    std::cout << \"input=511 runtime_error\\n\";\n    return 0;\n  }\n  std::cout << \"input=511 evaluated=\" << value->bits\n            << \" width=\" << unsigned(value->width) << '\\n';\n  if (value->bits != supplied)\n    return 1;\n  return 0;\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-A/demonstration/probe_slice\nexpression=r0[0:0] width=1\n$ /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-A/demonstration/probe_bool_width\ncomparison_width=1 logical_width=1\n$ /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-A/demonstration/probe_truncation\ninput=511 evaluated=255 width=8\n"

B 产物提交：e61883390d37475ab6079cd868f725fb08a480f7
B 没有实际执行的测试命令，不据此声称测试通过。

B 预热命令：python3 '{support}/probe.py' build '{workspace}'

B 检查：切片与布尔结果位宽
复现命令：python3 '{support}/probe.py' widths '{workspace}'

B 检查：超宽寄存器值与条件短路
复现命令：python3 '{support}/probe.py' runtime '{workspace}'

B 检查：随机 AST 覆盖范围
复现命令：python3 '{support}/probe.py' coverage '{workspace}'

B 检查：VM 指令边界恢复
复现命令：python3 '{support}/probe.py' resume '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.py以 JSON 字符串记录，解码后可还原完整输入文件："#!/usr/bin/env python3\nimport pathlib\nimport re\nimport subprocess\nimport sys\n\nSUPPORT = pathlib.Path(__file__).resolve().parent\nCOMPILER = \"/usr/bin/c++\"\nSOURCES = [\"parser.cpp\", \"eval.cpp\", \"compiler.cpp\", \"verifier.cpp\", \"vm.cpp\", \"bytecode.cpp\"]\n\n\ndef fail(message, code=1):\n    print(message)\n    raise SystemExit(code)\n\n\ndef build(workspace):\n    workspace = pathlib.Path(workspace)\n    version = subprocess.run([COMPILER, \"--version\"], text=True, capture_output=True, check=True).stdout.splitlines()[0]\n    command = [COMPILER, \"-std=c++20\", \"-O2\", \"-Wall\", \"-Wextra\", \"-I\", str(workspace / \"include\"), str(SUPPORT / \"probe.cpp\")]\n    command += [str(workspace / \"src\" / name) for name in SOURCES]\n    command += [\"-o\", str(SUPPORT / \"probe-bin\")]\n    try:\n        result = subprocess.run(command, text=True, capture_output=True, timeout=110)\n    except subprocess.TimeoutExpired:\n        fail(\"probe timed out\", 124)\n    if result.returncode:\n        print(result.stdout, end=\"\")\n        print(result.stderr, end=\"\")\n        fail(\"probe build failed\", result.returncode)\n    print(f\"compiler={version}; standard=c++20; probe=ready\")\n\n\ndef coverage(workspace):\n    path = pathlib.Path(workspace) / \"tests\" / \"test_exhaustive.cpp\"\n    text = path.read_text(encoding=\"utf-8\")\n    match = re.search(r\"for\\s*\\(int iter\\s*=\\s*0;\\s*iter\\s*<\\s*(\\d+);\\s*\\+\\+iter\\)\", text)\n    if not match or \"TEST(random_ast_vs_vm_with_resume)\" not in text:\n        fail(\"coverage source assertion failed\")\n    cases = re.findall(r\"TEST\\((exhaustive_[a-z0-9_]+)\\)\", text)\n    if len(cases) != 7:\n        fail(\"fixed exhaustive case count changed\")\n    print(f\"source={path.name} fixed_exhaustive_cases={len(cases)} random_ast_iterations={match.group(1)}\")\n    print(\"random_ast=sampled; full_ast_input_enumeration=absent\")\n\n\ndef main():\n    if len(sys.argv) < 2:\n        fail(\"expected mode\")\n    mode = sys.argv[1]\n    if mode == \"build\":\n        if len(sys.argv) != 3:\n            fail(\"build requires workspace\")\n        build(sys.argv[2])\n    elif mode == \"coverage\":\n        if len(sys.argv) != 3:\n            fail(\"coverage requires workspace\")\n        coverage(sys.argv[2])\n    elif mode in {\"widths\", \"runtime\", \"resume\"}:\n        try:\n            result = subprocess.run([str(SUPPORT / \"probe-bin\"), mode], text=True, capture_output=True, timeout=40)\n        except subprocess.TimeoutExpired:\n            fail(\"probe timed out\", 124)\n        output = result.stdout + result.stderr\n        print(output, end=\"\")\n        if result.returncode:\n            fail(\"probe assertion failed\", result.returncode)\n    else:\n        fail(\"unknown mode\")\n\n\nif __name__ == \"__main__\":\n    main()\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-B/demonstration/probe.py widths /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/record/B/attempt-001/workspace\nslice4=rejected@2 slice8=8 compare=8 logic=8\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-B/demonstration/probe.py runtime /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/record/B/attempt-001/workspace\nskipped=AST:0,VM:0 reached=AST:RuntimeError,VM:Error\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-B/demonstration/probe.py coverage /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/record/B/attempt-001/workspace\nsource=test_exhaustive.cpp fixed_exhaustive_cases=7 random_ast_iterations=400\nrandom_ast=sampled; full_ast_input_enumeration=absent\n$ python3 /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/judge/pair/attempt-002/demonstration-B/demonstration/probe.py resume /home/delin/.local/share/gsb-workbench/artifacts/6b47071bdbfa448c9d98420270d378cc/record/B/attempt-001/workspace\ninstruction_boundaries=9 ast_vm=match resume=match\n"
