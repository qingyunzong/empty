#pragma once

// 时态库存物品位置存储
// ---------------------------------------------------------------------------
// 每个物品位置记录带有:
//   * 业务区间 [from, to)        —— 半开区间,from 生效、to 失效
//   * 知悉序号 knowledge         —— 记录被系统知悉的单调递增序号
// 撤销本身也是一个知悉事件:仅当查询的知悉序号 K >= 撤销事件的序号时才生效。
// 查询 query(K, t):在所有“知悉可见”(knowledge <= K 且未被 K 可见的撤销命中)
// 且覆盖 t 的记录中,取知悉序号最高者,返回来源记录本身(不合成、不改写)。
// 补录(较晚知悉但业务时间更早的记录)按最高知悉序号优先自然“分裂”当前视图,
// 由于事件日志只追加,旧知悉序号 K 下的快照完全不受影响。
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <vector>

namespace temporal {

struct Record {
    std::uint64_t id;         // 来源记录标识
    std::int64_t  from;       // 业务区间起点(含)
    std::int64_t  to;         // 业务区间终点(不含)
    std::int64_t  location;   // 位置载荷(库位编码)
    std::uint64_t knowledge;  // 知悉序号
};

struct Revocation {
    std::uint64_t recordId;   // 被撤销的记录
    std::uint64_t knowledge;  // 撤销事件的知悉序号
};

// 快照分段:某段业务区间内的可见来源记录(无记录时为 nullopt)
struct Segment {
    std::int64_t from;
    std::int64_t to;
    std::optional<std::uint64_t> recordId;

    friend bool operator==(const Segment&, const Segment&) = default;
};

class Store {
  public:
    // 补录/录入一条位置记录,返回记录 id。空区间非法。
    std::uint64_t insert(std::int64_t from, std::int64_t to, std::int64_t location) {
        if (from >= to) throw std::invalid_argument("empty business interval");
        const std::uint64_t id = records_.size();
        records_.push_back(Record{id, from, to, location, nextKnowledge()});
        return id;
    }

    // 撤销一条记录;撤销仅在自身的知悉序号之后(含)对查询生效。
    void revoke(std::uint64_t id) {
        if (id >= records_.size()) throw std::invalid_argument("unknown record id");
        revocations_.push_back(Revocation{id, nextKnowledge()});
    }

    // 当前已分配的知悉序号上限(即“最新”的 K)
    std::uint64_t currentKnowledge() const { return seq_; }

    // 记录 id 在知悉序号 K 下是否已被撤销
    bool revokedAt(std::uint64_t id, std::uint64_t K) const {
        for (const Revocation& rev : revocations_)
            if (rev.recordId == id && rev.knowledge <= K) return true;
        return false;
    }

    // 查询:知悉序号 K 下、业务时刻 t 的可见来源记录(取最高知悉序号)。
    // 返回指向内部来源记录的指针,未命中返回 nullptr。
    const Record* query(std::uint64_t K, std::int64_t t) const {
        const Record* best = nullptr;
        for (const Record& rec : records_) {
            if (rec.knowledge > K) continue;                 // 知悉不可见
            if (t < rec.from || t >= rec.to) continue;       // 半开区间
            if (revokedAt(rec.id, K)) continue;              // 已被可见撤销命中
            if (best == nullptr || rec.knowledge > best->knowledge) best = &rec;
        }
        return best;
    }

    // 知悉序号 K 下的完整快照:按业务区间边界扫描成分段,
    // 每段给出该段的可见来源记录 id(或空)。
    std::vector<Segment> snapshot(std::uint64_t K) const {
        std::vector<std::int64_t> bounds;
        for (const Record& rec : records_) {
            if (rec.knowledge > K || revokedAt(rec.id, K)) continue;
            bounds.push_back(rec.from);
            bounds.push_back(rec.to);
        }
        std::sort(bounds.begin(), bounds.end());
        bounds.erase(std::unique(bounds.begin(), bounds.end()), bounds.end());

        std::vector<Segment> out;
        for (std::size_t i = 0; i + 1 < bounds.size(); ++i) {
            const Record* winner = query(K, bounds[i]);
            std::optional<std::uint64_t> id =
                winner ? std::optional<std::uint64_t>(winner->id) : std::nullopt;
            // 合并相邻且来源记录相同的分段,得到“补录分裂”后的最简视图
            if (!out.empty() && out.back().recordId == id && out.back().to == bounds[i]) {
                out.back().to = bounds[i + 1];
            } else {
                out.push_back(Segment{bounds[i], bounds[i + 1], id});
            }
        }
        return out;
    }

    const std::vector<Record>& records() const { return records_; }
    const std::vector<Revocation>& revocations() const { return revocations_; }

  private:
    std::uint64_t nextKnowledge() { return ++seq_; }

    std::uint64_t seq_ = 0;
    std::vector<Record> records_;
    std::vector<Revocation> revocations_;
};

} // namespace temporal
