// 时态库存位置存储测试
// 包含:语义单元测试 + 二维小域栅格(知悉序号 K × 业务时刻 t)参考核验
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <random>
#include <temporal/store.hpp>

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);        \
            ++failures;                                                        \
        }                                                                      \
    } while (0)

// ---------------------------------------------------------------------------
// 朴素参考模型:独立实现,直接从事件日志逐条过滤,用于栅格核验
// ---------------------------------------------------------------------------
struct RefModel {
    struct Ev { bool isRevoke; std::uint64_t recId; std::int64_t from, to, loc; std::uint64_t k; };
    std::vector<Ev> events;
    std::uint64_t seq = 0;

    std::uint64_t insert(std::int64_t from, std::int64_t to, std::int64_t loc) {
        std::uint64_t id = 0;
        for (const auto& e : events) if (!e.isRevoke) ++id;
        events.push_back(Ev{false, id, from, to, loc, ++seq});
        return id;
    }
    void revoke(std::uint64_t id) { events.push_back(Ev{true, id, 0, 0, 0, ++seq}); }

    // 返回 (记录 id, 库位),无可见记录返回 nullopt
    std::optional<std::pair<std::uint64_t, std::int64_t>> query(std::uint64_t K,
                                                                std::int64_t t) const {
        std::optional<std::pair<std::uint64_t, std::int64_t>> best;
        std::uint64_t bestK = 0;
        for (const auto& e : events) {
            if (e.isRevoke || e.k > K) continue;
            if (t < e.from || t >= e.to) continue;
            bool revoked = false;
            for (const auto& r : events)
                if (r.isRevoke && r.recId == e.recId && r.k <= K) revoked = true;
            if (revoked) continue;
            if (!best || e.k > bestK) { best = std::pair{e.recId, e.loc}; bestK = e.k; }
        }
        return best;
    }
};

// 二维小域栅格核验:对所有 (K, t) 组合,Store 必须与参考模型一致;
// 同时校验 snapshot 分段与 query 逐点结果一致。
static void gridVerify(const temporal::Store& store, const RefModel& ref,
                       std::int64_t tMin, std::int64_t tMax) {
    const std::uint64_t kMax = store.currentKnowledge();
    for (std::uint64_t K = 0; K <= kMax; ++K) {
        auto segs = store.snapshot(K);
        for (std::int64_t t = tMin; t < tMax; ++t) {
            auto expected = ref.query(K, t);
            const temporal::Record* got = store.query(K, t);
            CHECK(expected.has_value() == (got != nullptr));
            if (expected && got) {
                CHECK(got->id == expected->first);
                CHECK(got->location == expected->second);
                // 输出来源记录:返回的必须是原始区间,而非分裂后的片段
                const auto& recs = store.records();
                CHECK(got->from == recs[got->id].from && got->to == recs[got->id].to);
            }
            // snapshot 分段必须与逐点查询一致
            bool covered = false;
            for (const auto& s : segs) {
                if (t >= s.from && t < s.to) {
                    covered = true;
                    CHECK(s.recordId.has_value() == expected.has_value());
                    if (s.recordId && expected) CHECK(*s.recordId == expected->first);
                }
            }
            if (expected) CHECK(covered);
        }
    }
}

// ---------------------------------------------------------------------------
static void testHalfOpenAndMaxKnowledge() {
    temporal::Store store;
    auto a = store.insert(0, 10, 1);   // k=1
    auto b = store.insert(4, 8, 2);    // k=2 补录,与 a 重叠

    // 半开区间:from 含、to 不含
    CHECK(store.query(1, 0) != nullptr);
    CHECK(store.query(1, 9) != nullptr);
    CHECK(store.query(1, 10) == nullptr);
    CHECK(store.query(1, -1) == nullptr);

    // 按知悉可见记录取最高序号:K=1 时 b 不可见,K=2 时重叠区 b 胜出
    CHECK(store.query(1, 5)->id == a);
    CHECK(store.query(2, 5)->id == b);
    CHECK(store.query(2, 5)->location == 2);
    CHECK(store.query(2, 2)->id == a);   // 非重叠区仍是 a
    // 输出来源记录:返回原始区间 [4,8),不是裁剪片段
    CHECK(store.query(2, 5)->from == 4 && store.query(2, 5)->to == 8);
}

static void testRevocationTiming() {
    temporal::Store store;
    auto a = store.insert(0, 10, 1);   // k=1
    store.revoke(a);                   // 撤销事件 k=2

    // 撤销仅在其知悉后生效:K=1 仍可见,K=2 起不可见
    CHECK(store.query(1, 5) != nullptr);
    CHECK(store.query(2, 5) == nullptr);
    CHECK(store.query(3, 5) == nullptr);
    CHECK(store.revokedAt(a, 1) == false);
    CHECK(store.revokedAt(a, 2) == true);
}

static void testBackfillSplitKeepsOldSnapshots() {
    temporal::Store store;
    store.insert(0, 10, 1);            // k=1
    auto snapK1 = store.snapshot(1);   // 旧快照

    store.insert(3, 6, 2);             // k=2 补录,分裂当前视图
    store.insert(5, 9, 3);             // k=3 再补录

    // 补录分裂不改旧快照
    CHECK(store.snapshot(1) == snapK1);
    CHECK(snapK1.size() == 1 && snapK1[0].from == 0 && snapK1[0].to == 10);

    // 当前快照被分裂为 [0,3)->#0 [3,5)->#1 [5,9)->#2 [9,10)->#0
    auto cur = store.snapshot(store.currentKnowledge());
    CHECK(cur.size() == 4);
    CHECK(cur[0].from == 0 && cur[0].to == 3 && cur[0].recordId == 0);
    CHECK(cur[1].from == 3 && cur[1].to == 5 && cur[1].recordId == 1);
    CHECK(cur[2].from == 5 && cur[2].to == 9 && cur[2].recordId == 2);
    CHECK(cur[3].from == 9 && cur[3].to == 10 && cur[3].recordId == 0);
}

static void testGridReference() {
    // 手工场景的小域栅格核验
    temporal::Store store;
    RefModel ref;
    auto checkIds = [&](std::uint64_t a, std::uint64_t b) { CHECK(a == b); };

    checkIds(store.insert(0, 6, 10), ref.insert(0, 6, 10));   // k=1
    checkIds(store.insert(2, 4, 20), ref.insert(2, 4, 20));   // k=2 补录
    checkIds(store.insert(5, 9, 30), ref.insert(5, 9, 30));   // k=3
    store.revoke(0); ref.revoke(0);                           // k=4
    checkIds(store.insert(1, 3, 40), ref.insert(1, 3, 40));   // k=5 撤销后补录
    store.revoke(2); ref.revoke(2);                           // k=6

    gridVerify(store, ref, -2, 12);
}

static void testRandomizedGridReference() {
    // 随机操作序列 + 全栅格核验(固定种子,可复现)
    std::mt19937_64 rng(20261006);
    for (int trial = 0; trial < 30; ++trial) {
        temporal::Store store;
        RefModel ref;
        std::vector<std::uint64_t> ids;
        const int ops = 1 + static_cast<int>(rng() % 12);
        for (int i = 0; i < ops; ++i) {
            if (!ids.empty() && rng() % 4 == 0) {
                std::uint64_t id = ids[rng() % ids.size()];
                store.revoke(id);
                ref.revoke(id);
            } else {
                std::int64_t from = static_cast<std::int64_t>(rng() % 12);
                std::int64_t to = from + 1 + static_cast<std::int64_t>(rng() % 6);
                std::int64_t loc = static_cast<std::int64_t>(rng() % 100);
                ids.push_back(store.insert(from, to, loc));
                ref.insert(from, to, loc);
            }
        }
        gridVerify(store, ref, -1, 20);
    }
}

int main() {
    testHalfOpenAndMaxKnowledge();
    testRevocationTiming();
    testBackfillSplitKeepsOldSnapshots();
    testGridReference();
    testRandomizedGridReference();

    if (failures == 0) {
        std::printf("all tests passed\n");
        return 0;
    }
    std::printf("%d check(s) failed\n", failures);
    return 1;
}
