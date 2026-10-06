// 演示：双时态库存物品位置查询。
#include <iostream>
#include <string>

#include "bitemporal_store.hpp"

namespace {

void show(const bitemp::Store& store, const std::string& item, std::int64_t t,
          std::int64_t k) {
    auto r = store.query(item, t, k);
    std::cout << "query(item=" << item << ", t=" << t << ", k=" << k
              << ") -> ";
    if (!r) {
        std::cout << "<无记录>\n";
    } else {
        std::cout << "位置=" << r->location << " 来源记录=#" << r->record_id
                  << " 业务区间=[" << r->valid_from << "," << r->valid_to
                  << ") 知悉区间=[" << r->know_from << ","
                  << (r->know_to == bitemp::kOpen
                          ? std::string("inf")
                          : std::to_string(r->know_to))
                  << ")\n";
    }
}

}  // namespace

int main() {
    bitemp::Store store;

    // 序号 1：记录箱子 A 在业务时间 [10, 20) 位于“东仓”。
    store.insert("A", 10, 20, "东仓", 1, 1001);
    // 序号 2：补录更精确的位置——[12, 15) 实际在“东仓-3号架”。
    store.insert("A", 12, 15, "东仓-3号架", 2, 1002);
    // 序号 3：撤销 [18, 25) 的位置记录（仅在序号 3 之后可见）。
    store.retract("A", 18, 25, 3);

    // 旧快照不受补录分裂影响：序号 1 时整段都是“东仓”。
    show(store, "A", 13, 1);
    // 序号 2 起，[12,15) 可见补录后的最高序号记录。
    show(store, "A", 13, 2);
    // 撤销仅在其知悉后生效：序号 2 时 t=19 仍是“东仓”。
    show(store, "A", 19, 2);
    // 序号 3 起，t=19 已无任何记录。
    show(store, "A", 19, 3);
    // 半开区间边界：t=20 不在 [10,20) 内。
    show(store, "A", 20, 3);
    return 0;
}
