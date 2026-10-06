// 演示:时态库存物品位置的录入、补录、撤销与按知悉序号查询
#include <cstdio>
#include <temporal/store.hpp>

static void printSnapshot(const temporal::Store& store, std::uint64_t K) {
    std::printf("  K=%llu 快照:", static_cast<unsigned long long>(K));
    auto segs = store.snapshot(K);
    if (segs.empty()) std::printf(" (空)");
    for (const auto& s : segs) {
        std::printf("  [%lld,%lld)->", static_cast<long long>(s.from),
                    static_cast<long long>(s.to));
        if (s.recordId) {
            const auto* r = store.query(K, s.from);
            std::printf("记录#%llu(库位%lld)", static_cast<unsigned long long>(*s.recordId),
                        static_cast<long long>(r->location));
        } else {
            std::printf("(空档)");
        }
    }
    std::printf("\n");
}

int main() {
    temporal::Store store;

    // 1) 初始录入:物品在 [0,10) 位于库位 A(编码 1)
    auto a = store.insert(0, 10, 1);
    // 2) 补录:较晚知悉,业务区间 [4,8) 实际在库位 B(编码 2) —— 分裂当前视图
    auto b = store.insert(4, 8, 2);
    // 3) 撤销记录 a;撤销仅在自身的知悉序号之后生效
    store.revoke(a);

    const std::uint64_t latest = store.currentKnowledge();
    std::printf("知悉序号: 记录#%llu(k=1) 记录#%llu(k=2) 撤销(k=3)\n",
                static_cast<unsigned long long>(a), static_cast<unsigned long long>(b));

    for (std::uint64_t K = 1; K <= latest; ++K) printSnapshot(store, K);

    // 按知悉可见记录取最高序号:K=2 时撤销尚不可见,t=5 命中补录记录 b
    const auto* hit = store.query(2, 5);
    std::printf("query(K=2, t=5) -> 记录#%llu 库位%lld (来源区间 [%lld,%lld))\n",
                static_cast<unsigned long long>(hit->id),
                static_cast<long long>(hit->location),
                static_cast<long long>(hit->from), static_cast<long long>(hit->to));

    // 撤销知悉后:K=3,t=1 已无可见记录
    std::printf("query(K=3, t=1) -> %s\n", store.query(3, 1) ? "有记录" : "无可见记录");
    return 0;
}
