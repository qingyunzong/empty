#pragma once

// 汇编分支缩短（branch shortening）求解器。
//
// 模型：一段指令序列，普通指令定长；每条相对跳转有短/长两种编码，
// 短编码位移范围窄（默认 [-128,127]，如 x86 rel8），长编码范围宽。
// 某条跳转由短变长会增大其后所有指令的偏移，可能使别的跳转越界。
// 目标：在所有跳转位移都合法的前提下，使代码总长度最短。
//
// 求解：从全短编码出发做松弛迭代，每轮把所有越界跳转拉长，直到不动点。
// “越界即拉长”算子关于编码选择是单调的，故收敛到最小不动点，
// 其每个分量都不大于任何可行解，因此总长度最优。
// 正确性由 brute_force() 对全部 2^J 种长短组合（J <= 20）的枚举核对。

#include <cstdint>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace branch {

struct Instruction {
    int size = 1;                 // 普通指令长度（字节）
    bool is_jump = false;         // 是否为相对跳转
    int target = 0;               // 跳转目标（指令下标）
    int short_size = 2;           // 短编码长度
    int long_size = 5;            // 长编码长度
    long short_min = -128;        // 短编码位移合法范围
    long short_max = 127;
    long long_min = -2147483648L; // 长编码位移合法范围
    long long_max = 2147483647L;
};

struct Layout {
    std::vector<bool> is_long; // 每条指令的编码选择（仅跳转有意义）
    std::vector<long> offset;  // 每条指令的偏移
    long total = 0;            // 代码总长度
    bool feasible = true;      // 所有跳转是否均合法
};

inline int instr_size(const Instruction& ins, bool is_long) {
    return ins.is_jump ? (is_long ? ins.long_size : ins.short_size) : ins.size;
}

// 位移 = 目标偏移 - (跳转偏移 + 跳转自身长度)，与 x86 相对跳转一致。
inline long displacement(const Layout& l, const Instruction& ins, size_t i) {
    return l.offset[ins.target] - (l.offset[i] + instr_size(ins, l.is_long[i]));
}

inline bool jump_legal(const Layout& l, const Instruction& ins, size_t i) {
    long d = displacement(l, ins, i);
    return l.is_long[i] ? (d >= ins.long_min && d <= ins.long_max)
                        : (d >= ins.short_min && d <= ins.short_max);
}

inline Layout layout(const std::vector<Instruction>& prog,
                     const std::vector<bool>& is_long) {
    Layout l;
    l.is_long = is_long;
    l.offset.resize(prog.size());
    long pos = 0;
    for (size_t i = 0; i < prog.size(); ++i) {
        l.offset[i] = pos;
        pos += instr_size(prog[i], is_long[i]);
    }
    l.total = pos;
    for (size_t i = 0; i < prog.size(); ++i)
        if (prog[i].is_jump && !jump_legal(l, prog[i], i)) l.feasible = false;
    return l;
}

struct SolveResult {
    Layout best;                    // 最短合法布局；不可行时 feasible=false
    std::vector<std::string> trace; // 迭代轨迹
};

inline SolveResult solve(const std::vector<Instruction>& prog) {
    SolveResult r;
    std::vector<bool> enc(prog.size(), false); // 全部从短编码出发
    for (int iter = 0;; ++iter) {
        Layout l = layout(prog, enc);
        std::vector<size_t> bad;
        for (size_t i = 0; i < prog.size(); ++i)
            if (prog[i].is_jump && !jump_legal(l, prog[i], i)) bad.push_back(i);

        std::ostringstream os;
        os << "iter " << iter << ": 总长度=" << l.total << " 越界跳转={";
        for (size_t k = 0; k < bad.size(); ++k)
            os << (k ? "," : "") << bad[k];
        os << "}";
        r.trace.push_back(os.str());

        if (bad.empty()) {
            r.best = l;
            r.trace.push_back("收敛：所有跳转合法，达到最小不动点");
            return r;
        }
        for (size_t i : bad) {
            if (enc[i]) { // 已是长编码仍越界 → 无可行布局
                r.best = l;
                r.best.feasible = false;
                r.trace.push_back("失败：跳转 " + std::to_string(i) +
                                  " 长编码仍越界，问题不可行");
                return r;
            }
            enc[i] = true;
        }
        r.trace.push_back("  -> 拉长 " + std::to_string(bad.size()) + " 条跳转");
    }
}

// 小规模枚举核对：穷举全部 2^J 种长短组合，返回可行布局的最短总长。
inline std::optional<long> brute_force(const std::vector<Instruction>& prog) {
    std::vector<size_t> jumps;
    for (size_t i = 0; i < prog.size(); ++i)
        if (prog[i].is_jump) jumps.push_back(i);
    if (jumps.size() >= 63) return std::nullopt;
    std::optional<long> best;
    const uint64_t cases = uint64_t{1} << jumps.size();
    std::vector<bool> enc(prog.size(), false);
    for (uint64_t mask = 0; mask < cases; ++mask) {
        for (size_t j = 0; j < jumps.size(); ++j)
            enc[jumps[j]] = (mask >> j) & 1;
        Layout l = layout(prog, enc);
        if (l.feasible && (!best || l.total < *best)) best = l.total;
    }
    return best;
}

// 偏移证书：逐条列出偏移、编码、目标、位移与合法性。
inline std::string certificate(const std::vector<Instruction>& prog,
                               const SolveResult& r) {
    std::ostringstream os;
    os << "=== 偏移证书 ===\n";
    os << "总长度 = " << r.best.total
       << " 字节, 可行 = " << (r.best.feasible ? "是" : "否") << "\n";
    os << "指令  偏移  大小  编码  目标    位移  合法\n";
    for (size_t i = 0; i < prog.size(); ++i) {
        const Instruction& ins = prog[i];
        os << std::setw(3) << i << "  " << std::setw(5) << r.best.offset[i]
           << "  " << std::setw(3) << instr_size(ins, r.best.is_long[i]) << "  ";
        if (!ins.is_jump) {
            os << "-\n";
            continue;
        }
        os << (r.best.is_long[i] ? "长    " : "短    ") << std::setw(3)
           << ins.target << "  " << std::setw(6) << displacement(r.best, ins, i)
           << "  " << (jump_legal(r.best, ins, i) ? "是" : "否") << "\n";
    }
    return os.str();
}

} // namespace branch
