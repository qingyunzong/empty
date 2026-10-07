

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：0b16305979264448a8732e9b0b6f5c4ae9c0760b
A 没有实际执行的测试命令，不据此声称测试通过。

A 预热命令：/usr/bin/g++-15 -std=c++20 -O2 -I '{workspace}/include' '{workspace}/src/adjacency_intersection.cpp' '{support}/probe.cpp' -o '{support}/probe'

A 检查：空游标与零预算
复现命令：'{support}/probe' empty

A 检查：重复命中与多来源保留
复现命令：'{support}/probe' sources

A 检查：游标中途报错
复现命令：'{support}/probe' atomic

A 检查：大输入驻留预算
复现命令：'{support}/probe' large
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.cpp以 JSON 字符串记录，解码后可还原完整输入文件："#include \"graph/adjacency_intersection.hpp\"\n\n#include <iostream>\n#include <memory>\n#include <vector>\n\nusing namespace graph;\n\nclass VectorCursor final : public AdjacencyCursor {\npublic:\n    explicit VectorCursor(std::vector<AdjacencyEntry> entries,\n                          std::size_t fail_at = static_cast<std::size_t>(-1))\n        : entries_(std::move(entries)), fail_at_(fail_at) {}\n\n    Expected<std::optional<AdjacencyEntry>, CursorError> next() override {\n        if (pos_ == fail_at_) return decltype(next())::err({\"probe cursor failure\"});\n        if (pos_ == entries_.size()) return decltype(next())::ok(std::nullopt);\n        return decltype(next())::ok(entries_[pos_++]);\n    }\n\nprivate:\n    std::vector<AdjacencyEntry> entries_;\n    std::size_t pos_ = 0;\n    std::size_t fail_at_;\n};\n\nstd::shared_ptr<AdjacencyCursor> cursor(std::vector<AdjacencyEntry> entries,\n                                       std::size_t fail_at = static_cast<std::size_t>(-1)) {\n    return std::make_shared<VectorCursor>(std::move(entries), fail_at);\n}\n\nint fail(const char* reason) {\n    std::cerr << \"ASSERTION FAILED: \" << reason << '\\n';\n    return 1;\n}\n\nint main(int argc, char** argv) {\n    if (argc != 2) return fail(\"expected one probe case\");\n    const std::string mode = argv[1];\n    if (mode == \"empty\") {\n        std::vector<std::shared_ptr<AdjacencyCursor>> inputs{cursor({})};\n        auto result = intersect_adjacency(inputs, MemoryBudget{0});\n        if (!result || !result.value().hits.empty() || result.value().peak_resident_ids != 0)\n            return fail(\"empty zero-budget case did not succeed with peak 0\");\n        std::cout << \"success: empty intersection, peak=\" << result.value().peak_resident_ids << '\\n';\n        return 0;\n    }\n    if (mode == \"sources\") {\n        std::vector<std::shared_ptr<AdjacencyCursor>> inputs{\n            cursor({{3, 1}, {3, 1}, {3, 2}, {5, 1}, {5, 1}}),\n            cursor({{3, 7}, {3, 7}, {5, 8}, {5, 9}, {5, 9}})};\n        auto result = intersect_adjacency(inputs, MemoryBudget{3});\n        if (!result || result.value().hits.size() != 2 ||\n            result.value().hits[0] != IntersectionHit{3, {1, 2, 7}} ||\n            result.value().hits[1] != IntersectionHit{5, {1, 8, 9}})\n            return fail(\"duplicate nodes or merged source IDs differ from expected result\");\n        std::cout << \"hits=2; node3 sources=1,2,7; node5 sources=1,8,9; unique=2\\n\";\n        return 0;\n    }\n    if (mode == \"atomic\") {\n        std::vector<std::shared_ptr<AdjacencyCursor>> inputs{\n            cursor({{1, 10}, {2, 10}}), cursor({{1, 20}, {2, 20}}, 1)};\n        auto result = intersect_adjacency(inputs, MemoryBudget{3});\n        if (result || result.error().code != IntersectionErrorCode::kCursorFailure ||\n            result.error().cursor_index != 1)\n            return fail(\"mid-stream cursor failure was not returned\");\n        std::cout << \"error=cursor failure; cursor=1; partial result published=false\\n\";\n        return 0;\n    }\n    if (mode == \"large\") {\n        constexpr NodeId n = 200000;\n        std::vector<std::vector<AdjacencyEntry>> lists(4);\n        for (NodeId i = 0; i < n; ++i) {\n            for (std::size_t k = 0; k < lists.size(); ++k) {\n                if (i % (k + 2) == 0) {\n                    lists[k].push_back({i, static_cast<SourceId>(k)});\n                    lists[k].push_back({i, static_cast<SourceId>(k + 100)});\n                }\n            }\n        }\n        std::vector<std::shared_ptr<AdjacencyCursor>> inputs;\n        for (auto& list : lists) inputs.push_back(cursor(std::move(list)));\n        auto result = intersect_adjacency(inputs, MemoryBudget{5});\n        if (!result || result.value().peak_resident_ids > 5 || result.value().hits.size() != 3334)\n            return fail(\"large-input result or resident-ID bound mismatch\");\n        std::cout << \"nodes=200000; sets=4; hits=\" << result.value().hits.size()\n                  << \"; peak=\" << result.value().peak_resident_ids << \"/5\\n\";\n        return 0;\n    }\n    return fail(\"unknown probe case\");\n}\n"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /home/delin/.local/share/gsb-workbench/artifacts/8ac2f14ec9194c9f8265177519d75105/judge/pair/attempt-001/demonstration-A/demonstration/probe empty\nsuccess: empty intersection, peak=0\n$ /home/delin/.local/share/gsb-workbench/artifacts/8ac2f14ec9194c9f8265177519d75105/judge/pair/attempt-001/demonstration-A/demonstration/probe sources\nhits=2; node3 sources=1,2,7; node5 sources=1,8,9; unique=2\n$ /home/delin/.local/share/gsb-workbench/artifacts/8ac2f14ec9194c9f8265177519d75105/judge/pair/attempt-001/demonstration-A/demonstration/probe atomic\nerror=cursor failure; cursor=1; partial result published=false\n$ /home/delin/.local/share/gsb-workbench/artifacts/8ac2f14ec9194c9f8265177519d75105/judge/pair/attempt-001/demonstration-A/demonstration/probe large\nnodes=200000; sets=4; hits=3334; peak=5/5\n"

B 产物提交：8a24a12ad365e21f7635e8486d02360d217199c6
B 没有实际执行的测试命令，不据此声称测试通过。

B 预热命令：/usr/bin/g++ -std=c++20 '-I{workspace}/include' '{support}/B-empty-budget-probe.cpp' -o '{support}/B-empty-budget-probe'

B 检查：空游标与零预算
复现命令：'{support}/B-empty-budget-probe'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 B-empty-budget-probe.cpp以 JSON 字符串记录，解码后可还原完整输入文件："#include \"gs/intersect.hpp\"\n#include <iostream>\n#include <vector>\nint main() {\n    std::vector<gs::AdjacencyInput> inputs;\n    inputs.push_back(gs::AdjacencyInput{1, gs::Cursor{gs::VectorCursor{{}}}});\n    gs::MemoryBudget budget{0};\n    auto result = gs::intersectAdjacency(inputs, budget);\n    std::cout << (result ? \"success: empty intersection\"\n                         : \"error: \" + result.error().message) << '\\n';\n    return result ? 0 : 1;\n}\n"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /home/delin/.local/share/gsb-workbench/artifacts/8ac2f14ec9194c9f8265177519d75105/judge/pair/attempt-001/demonstration-B/demonstration/B-empty-budget-probe\nerror: memory budget too small: need one resident id per input cursor\n"

补充输出 A-empty-budget-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："success: empty intersection, peak=0\n"

补充输出 B-empty-budget-probe.log以 JSON 字符串记录，解码后可还原完整原始输出："error: memory budget too small: need one resident id per input cursor\n"
