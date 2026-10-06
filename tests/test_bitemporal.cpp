// 双时态库存位置存储测试：
//  1) 确定性语义用例（半开区间、知悉后生效、补录分裂不改旧快照、来源记录）；
//  2) 二维小域栅格参考核验——用操作日志重放的朴素参考实现，
//     在 (业务时刻 × 知悉序号) 小栅格上逐格比对。
#include <cstdint>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "bitemporal_store.hpp"

namespace {

int g_failures = 0;

#define CHECK(cond)                                                  \
    do {                                                             \
        if (!(cond)) {                                               \
            ++g_failures;                                            \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__      \
                      << "  CHECK(" #cond ")\n";                     \
        }                                                            \
    } while (0)

// ---- 朴素参考实现：直接按操作日志重放语义 ------------------------------
// 规则：对查询 (t, k)，在序号 <= k 且覆盖 t 的操作中取序号最高者；
// 若为补录则答案是其记录，若为撤销则无记录。
struct RefOp {
    bool is_insert;
    std::int64_t vs, ve, k;
    std::int64_t record_id;
    std::string location;
};

struct RefModel {
    std::vector<RefOp> ops;

    void insert(std::int64_t vs, std::int64_t ve, std::string loc,
                std::int64_t k, std::int64_t id) {
        ops.push_back(RefOp{true, vs, ve, k, id, std::move(loc)});
    }
    void retract(std::int64_t vs, std::int64_t ve, std::int64_t k) {
        ops.push_back(RefOp{false, vs, ve, k, 0, {}});
    }
    std::optional<std::pair<std::int64_t, std::string>> query(
        std::int64_t t, std::int64_t k) const {
        const RefOp* best = nullptr;
        for (const RefOp& op : ops) {
            if (op.k <= k && op.vs <= t && t < op.ve) {
                if (!best || op.k > best->k) best = &op;
            }
        }
        if (!best || !best->is_insert) return std::nullopt;
        return std::make_pair(best->record_id, best->location);
    }
};

// ---- 确定性用例 --------------------------------------------------------

void test_basic_and_half_open() {
    bitemp::Store s;
    s.insert("A", 10, 20, "东仓", 1, 1001);
    auto r = s.query("A", 10, 1);  // 左端点含
    CHECK(r && r->location == "东仓" && r->record_id == 1001);
    CHECK(s.query("A", 19, 1).has_value());
    CHECK(!s.query("A", 20, 1).has_value());  // 右端点不含（半开）
    CHECK(!s.query("A", 9, 1).has_value());
    CHECK(!s.query("A", 10, 0).has_value());  // 知悉序号不足
    CHECK(!s.query("B", 10, 1).has_value());  // 未知物品
}

void test_retroactive_split_keeps_old_snapshot() {
    bitemp::Store s;
    s.insert("A", 10, 20, "东仓", 1, 1001);
    s.insert("A", 12, 15, "东仓-3号架", 5, 1002);  // 补录，序号 5

    // 旧快照（序号 < 5）完全不受补录分裂影响
    for (std::int64_t t = 10; t < 20; ++t) {
        auto r = s.query("A", t, 4);
        CHECK(r && r->record_id == 1001 && r->location == "东仓");
    }
    // 序号 5 起：重叠区取最高序号记录，两侧仍是旧记录
    auto mid = s.query("A", 13, 5);
    CHECK(mid && mid->record_id == 1002 && mid->location == "东仓-3号架");
    auto left = s.query("A", 11, 5);
    CHECK(left && left->record_id == 1001);
    auto right = s.query("A", 16, 5);
    CHECK(right && right->record_id == 1001);
    // 来源段形状正确：旧段被分裂为 [10,12) 与 [15,20)
    CHECK(left->valid_from == 10 && left->valid_to == 12);
    CHECK(right->valid_from == 15 && right->valid_to == 20);
}

void test_retract_visible_only_after_known() {
    bitemp::Store s;
    s.insert("A", 10, 20, "东仓", 1, 1001);
    s.retract("A", 15, 25, 7);  // 序号 7 起撤销 [15,25)

    // 撤销在其知悉前不生效
    auto before = s.query("A", 17, 6);
    CHECK(before && before->record_id == 1001);
    // 知悉后：重叠区无记录，非重叠区仍在
    CHECK(!s.query("A", 17, 7).has_value());
    auto kept = s.query("A", 12, 7);
    CHECK(kept && kept->record_id == 1001);
    CHECK(kept->valid_from == 10 && kept->valid_to == 15);
    // 历史快照依旧完整
    CHECK(s.query("A", 17, 1).has_value());
}

void test_highest_visible_seq_wins() {
    bitemp::Store s;
    s.insert("A", 0, 10, "甲", 1, 1);
    s.insert("A", 0, 10, "乙", 3, 2);
    s.insert("A", 0, 10, "丙", 8, 3);
    auto r = s.query("A", 5, 5);  // 可见序号为 1、3，取最高
    CHECK(r && r->record_id == 2 && r->location == "乙");
    r = s.query("A", 5, 100);
    CHECK(r && r->record_id == 3 && r->location == "丙");
    r = s.query("A", 5, 2);
    CHECK(r && r->record_id == 1 && r->location == "甲");
}

void test_source_record_reported() {
    bitemp::Store s;
    s.insert("A", 0, 5, "北仓", 2, 9001);
    auto r = s.query("A", 3, 2);
    CHECK(r && r->record_id == 9001);
    CHECK(r->know_from == 2 && r->know_to == bitemp::kOpen);
    CHECK(r->valid_from == 0 && r->valid_to == 5);
}

void test_items_are_independent() {
    bitemp::Store s;
    s.insert("A", 0, 10, "甲", 1, 1);
    s.insert("B", 0, 10, "乙", 1, 2);
    s.retract("A", 0, 10, 2);
    CHECK(!s.query("A", 5, 2).has_value());
    auto r = s.query("B", 5, 2);
    CHECK(r && r->location == "乙");
}

void test_invalid_args_throw() {
    bitemp::Store s;
    bool threw = false;
    try {
        s.insert("A", 5, 5, "x", 1, 1);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
    threw = false;
    try {
        s.retract("A", 9, 3, 1);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

// ---- 二维小域栅格参考核验 ----------------------------------------------
// 业务时刻域 [0, kT)，知悉序号域 [0, kK]；随机生成补录/撤销序列，
// 每步之后在整个栅格上逐格比对 Store 与朴素参考实现。
void test_grid_cross_check() {
    constexpr std::int64_t kT = 12;   // 业务时刻小域
    constexpr std::int64_t kK = 40;   // 知悉序号小域
    constexpr int kRounds = 300;      // 随机场景数
    constexpr int kOps = 25;          // 每场景操作数
    const std::string items[2] = {"A", "B"};

    std::mt19937_64 rng(20261006);
    for (int round = 0; round < kRounds; ++round) {
        bitemp::Store store;
        RefModel ref[2];
        std::int64_t next_id = 1;
        for (int op = 0; op < kOps; ++op) {
            std::int64_t k = op + 1;  // 严格递增的知悉序号
            int item = static_cast<int>(rng() % 2);
            std::int64_t a = static_cast<std::int64_t>(rng() % kT);
            std::int64_t b = static_cast<std::int64_t>(rng() % kT);
            if (a > b) std::swap(a, b);
            if (a == b) b = a + 1;  // 保证非空半开区间
            bool is_insert = (rng() % 4) != 0;  // 75% 补录，25% 撤销
            std::string loc = "loc-" + std::to_string(rng() % 5);
            if (is_insert) {
                store.insert(items[item], a, b, loc, k, next_id);
                ref[item].insert(a, b, loc, k, next_id);
                ++next_id;
            } else {
                store.retract(items[item], a, b, k);
                ref[item].retract(a, b, k);
            }
            // 每步全栅格核验
            for (int it = 0; it < 2; ++it) {
                for (std::int64_t t = 0; t < kT; ++t) {
                    for (std::int64_t kq = 0; kq <= kK; ++kq) {
                        auto got = store.query(items[it], t, kq);
                        auto want = ref[it].query(t, kq);
                        bool ok =
                            (!got && !want) ||
                            (got && want && got->record_id == want->first &&
                             got->location == want->second);
                        if (!ok) {
                            ++g_failures;
                            std::cerr
                                << "FAIL grid round=" << round << " op=" << op
                                << " item=" << items[it] << " t=" << t
                                << " k=" << kq << "\n";
                            return;
                        }
                    }
                }
            }
        }
    }
}

}  // namespace

int main() {
    test_basic_and_half_open();
    test_retroactive_split_keeps_old_snapshot();
    test_retract_visible_only_after_known();
    test_highest_visible_seq_wins();
    test_source_record_reported();
    test_items_are_independent();
    test_invalid_args_throw();
    test_grid_cross_check();

    if (g_failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cerr << g_failures << " check(s) failed\n";
    return 1;
}
