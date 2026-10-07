#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <vector>

namespace interval_colors {

// 半开区间 [lo, hi) 上的一段纯色。
struct Segment {
    std::int64_t lo;
    std::int64_t hi;
    std::int64_t color;

    friend bool operator==(const Segment&, const Segment&) = default;
};

// 持久化区间染色表。
//
// 模型：每个版本是一份完整的有序段数组（vector<Segment>），段之间互不重迭、
// 按 lo 升序排列，且相邻段颜色必不相同（不变式在 paint 中维护）。
// paint 时整组复制基底版本的段数组，在副本上完成分裂/覆盖/合并后作为新版本
// 追加保存，因此任意旧版本永远不被修改，可任意分支。
class IntervalColors {
public:
    IntervalColors() : versions_(1) {} // 版本 0：空表

    // 新建一个空版本，返回其 id。
    int createVersion() {
        versions_.emplace_back();
        return static_cast<int>(versions_.size()) - 1;
    }

    int versionCount() const { return static_cast<int>(versions_.size()); }

    // 在 base 版本上把 [l, r) 染成 color，返回新版本 id。
    // 空范围（l >= r）不产生任何变更，直接返回 base。
    int paint(int base, std::int64_t l, std::int64_t r, std::int64_t color) {
        checkVersion(base);
        if (l >= r) return base;

        const std::vector<Segment>& src = versions_[base];
        std::vector<Segment> next;
        next.reserve(src.size() + 2);

        // 1) 复制并分裂：与 [l, r) 相交的旧段被截断为两侧残余。
        for (const Segment& s : src) {
            if (s.hi <= l || s.lo >= r) {
                next.push_back(s);
                continue;
            }
            if (s.lo < l) next.push_back({s.lo, l, s.color});
            if (s.hi > r) next.push_back({r, s.hi, s.color});
        }

        // 2) 按 lo 有序插入新段（此时 [l, r) 内已无其他段）。
        Segment fresh{l, r, color};
        auto pos = std::lower_bound(next.begin(), next.end(), fresh,
                                    [](const Segment& a, const Segment& b) {
                                        return a.lo < b.lo;
                                    });
        pos = next.insert(pos, fresh);

        // 3) 合并相邻同色段（先左后右）。
        if (pos != next.begin()) {
            auto prev = pos - 1;
            if (prev->hi == pos->lo && prev->color == pos->color) {
                pos->lo = prev->lo;
                pos = next.erase(prev);
            }
        }
        auto succ = pos + 1;
        if (succ != next.end() && pos->hi == succ->lo && pos->color == succ->color) {
            pos->hi = succ->hi;
            next.erase(succ);
        }

        versions_.push_back(std::move(next));
        return static_cast<int>(versions_.size()) - 1;
    }

    // 查询某版本的全部颜色段（有序、不重迭、相邻不同色）。
    const std::vector<Segment>& segments(int version) const {
        checkVersion(version);
        return versions_[version];
    }

    // 查询某版本中点 x 的颜色；未覆盖返回 nullopt。
    std::optional<std::int64_t> colorAt(int version, std::int64_t x) const {
        checkVersion(version);
        const auto& segs = versions_[version];
        auto it = std::upper_bound(segs.begin(), segs.end(), x,
                                   [](std::int64_t v, const Segment& s) {
                                       return v < s.lo;
                                   });
        if (it != segs.begin()) {
            --it;
            if (x < it->hi) return it->color;
        }
        return std::nullopt;
    }

    // 查询某版本中 [l, r) 被任意颜色覆盖的总长度。
    std::int64_t coveredLength(int version, std::int64_t l, std::int64_t r) const {
        checkVersion(version);
        if (l >= r) return 0;
        std::int64_t total = 0;
        for (const Segment& s : versions_[version]) {
            if (s.hi <= l) continue;
            if (s.lo >= r) break;
            total += std::min(s.hi, r) - std::max(s.lo, l);
        }
        return total;
    }

private:
    void checkVersion(int version) const {
        if (version < 0 || version >= static_cast<int>(versions_.size()))
            throw std::out_of_range("interval_colors: bad version id");
    }

    std::vector<std::vector<Segment>> versions_;
};

} // namespace interval_colors
