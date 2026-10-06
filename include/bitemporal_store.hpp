#pragma once

// 双时态库存物品位置存储。
//
// 每条记录占据二维时态平面上的一个矩形段（Segment）：
//   - 业务区间 [valid_from, valid_to)：物品位于该位置的业务时间，半开区间；
//   - 知悉区间 [know_from, know_to)：该段可被查询知悉的序号区间，半开区间，
//     know_to == kOpen 表示至今仍生效。
//
// 语义：
//   - 补录（insert）：以知悉序号 k 写入位置。与现行段（know_to == kOpen）
//     重叠的部分被分裂出去并在序号 k 处封闭，旧段其余部分保持不变——
//     旧快照（以小于 k 的序号查询）不受任何影响。
//   - 撤销（retract）：以知悉序号 k 生效，仅封闭现行段的重叠部分，
//     即撤销只在“被知悉之后”才可见；历史快照中记录依然存在。
//   - 查询（query）：在业务时刻 t、知悉序号 k 处，取同时覆盖 (t, k)
//     的段中知悉序号最高者，返回其来源记录号与位置。

#include <cstdint>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace bitemp {

// “仍生效”的知悉序号上界（开区间端点）。
inline constexpr std::int64_t kOpen = std::numeric_limits<std::int64_t>::max();

struct Segment {
    std::int64_t valid_from;  // 业务区间起点（含）
    std::int64_t valid_to;    // 业务区间终点（不含）
    std::int64_t know_from;   // 知悉序号起点（含）
    std::int64_t know_to;     // 知悉序号终点（不含），kOpen 表示仍生效
    std::int64_t record_id;   // 来源记录号
    std::string location;     // 物品位置
};

struct QueryResult {
    std::int64_t record_id;   // 来源记录号
    std::string location;     // 位置
    std::int64_t valid_from;  // 命中段的业务区间
    std::int64_t valid_to;
    std::int64_t know_from;   // 命中段的知悉区间
    std::int64_t know_to;
};

class Store {
  public:
    // 补录：自知悉序号 k 起，item 在业务区间 [vs, ve) 内位于 location。
    // record_id 为来源记录号，随查询结果返回。
    void insert(const std::string& item, std::int64_t vs, std::int64_t ve,
                std::string location, std::int64_t k, std::int64_t record_id) {
        check_interval(vs, ve, k);
        close_overlap(item, vs, ve, k);
        segments_[item].push_back(
            Segment{vs, ve, k, kOpen, record_id, std::move(location)});
    }

    // 撤销：自知悉序号 k 起，item 在业务区间 [vs, ve) 内的位置记录失效。
    // 仅封闭现行段的重叠部分，不改变任何历史快照。
    void retract(const std::string& item, std::int64_t vs, std::int64_t ve,
                 std::int64_t k) {
        check_interval(vs, ve, k);
        close_overlap(item, vs, ve, k);
    }

    // 查询：业务时刻 t、知悉序号 k 下可见且序号最高的记录。
    std::optional<QueryResult> query(const std::string& item, std::int64_t t,
                                     std::int64_t k) const {
        auto it = segments_.find(item);
        if (it == segments_.end()) return std::nullopt;
        const Segment* best = nullptr;
        for (const Segment& s : it->second) {
            if (s.valid_from <= t && t < s.valid_to && s.know_from <= k &&
                k < s.know_to) {
                if (!best || s.know_from > best->know_from) best = &s;
            }
        }
        if (!best) return std::nullopt;
        return QueryResult{best->record_id, best->location, best->valid_from,
                           best->valid_to, best->know_from, best->know_to};
    }

    // 只读访问内部段集合（供测试与核验）。
    const std::vector<Segment>& segments(const std::string& item) const {
        static const std::vector<Segment> empty;
        auto it = segments_.find(item);
        return it == segments_.end() ? empty : it->second;
    }

  private:
    static void check_interval(std::int64_t vs, std::int64_t ve,
                               std::int64_t k) {
        if (vs >= ve) throw std::invalid_argument("empty valid interval");
        if (k < 0 || k >= kOpen)
            throw std::invalid_argument("bad knowledge sequence");
    }

    // 将 item 现行段（know_to == kOpen）与 [vs, ve) 重叠的部分在序号 k
    // 处封闭；不重叠部分以新的现行段保留。旧段一律不被修改。
    void close_overlap(const std::string& item, std::int64_t vs,
                       std::int64_t ve, std::int64_t k) {
        auto& segs = segments_[item];
        std::vector<Segment> next;
        next.reserve(segs.size() + 2);
        for (const Segment& s : segs) {
            std::int64_t os = std::max(vs, s.valid_from);
            std::int64_t oe = std::min(ve, s.valid_to);
            if (s.know_to != kOpen || os >= oe) {
                next.push_back(s);  // 已封闭或不重叠：原样保留
                continue;
            }
            if (s.valid_from < os)  // 左侧不重叠部分仍生效
                next.push_back(Segment{s.valid_from, os, s.know_from, kOpen,
                                       s.record_id, s.location});
            // 重叠部分在序号 k 处封闭
            next.push_back(
                Segment{os, oe, s.know_from, k, s.record_id, s.location});
            if (oe < s.valid_to)  // 右侧不重叠部分仍生效
                next.push_back(Segment{oe, s.valid_to, s.know_from, kOpen,
                                       s.record_id, s.location});
        }
        segs = std::move(next);
    }

    std::unordered_map<std::string, std::vector<Segment>> segments_;
};

}  // namespace bitemp
