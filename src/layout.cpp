#include "layout.hpp"

#include <algorithm>
#include <cstdint>
#include <sstream>
#include <stdexcept>

namespace asmlayout {

Instruction Instruction::fixed(int size) {
    Instruction insn;
    insn.kind = Kind::Fixed;
    insn.fixed_size = size;
    return insn;
}

Instruction Instruction::jump(int target) {
    Instruction insn;
    insn.kind = Kind::Jump;
    insn.target = target;
    return insn;
}

void validate(const std::vector<Instruction>& prog) {
    for (std::size_t i = 0; i < prog.size(); ++i) {
        const auto& insn = prog[i];
        if (insn.kind == Instruction::Kind::Fixed) {
            if (insn.fixed_size <= 0)
                throw std::invalid_argument("fixed instruction " +
                                            std::to_string(i) +
                                            " has non-positive size");
        } else {
            if (insn.target < 0 ||
                static_cast<std::size_t>(insn.target) >= prog.size())
                throw std::invalid_argument("jump instruction " +
                                            std::to_string(i) +
                                            " has out-of-range target");
        }
    }
}

static int insn_size(const Instruction& insn, bool is_long,
                     const Encoding& enc) {
    if (insn.kind == Instruction::Kind::Fixed)
        return insn.fixed_size;
    return is_long ? enc.long_size : enc.short_size;
}

LayoutResult compute_layout(const std::vector<Instruction>& prog,
                            const Encoding& enc,
                            const std::vector<bool>& is_long) {
    const int n = static_cast<int>(prog.size());
    LayoutResult result;
    result.offsets.assign(n + 1, 0);
    result.is_long = is_long;
    result.displacement.assign(n, 0);
    result.feasible = true;

    for (int i = 0; i < n; ++i)
        result.offsets[i + 1] =
            result.offsets[i] + insn_size(prog[i], is_long[i], enc);
    result.total_length = result.offsets[n];

    for (int i = 0; i < n; ++i) {
        if (prog[i].kind != Instruction::Kind::Jump)
            continue;
        const int size = insn_size(prog[i], is_long[i], enc);
        const int disp = result.offsets[prog[i].target] - (result.offsets[i] + size);
        result.displacement[i] = disp;
        if (!is_long[i] && (disp < enc.short_min || disp > enc.short_max))
            result.feasible = false;
    }
    return result;
}

SolveResult solve_relaxation(const std::vector<Instruction>& prog,
                             const Encoding& enc) {
    validate(prog);
    SolveResult result;
    std::vector<bool> is_long(prog.size(), false);

    for (int iteration = 0;; ++iteration) {
        LayoutResult layout = compute_layout(prog, enc, is_long);
        TraceEntry entry;
        entry.iteration = iteration;
        entry.total_length = layout.total_length;
        for (int i = 0; i < static_cast<int>(prog.size()); ++i) {
            if (prog[i].kind != Instruction::Kind::Jump || is_long[i])
                continue;
            const int disp = layout.displacement[i];
            if (disp < enc.short_min || disp > enc.short_max)
                entry.flipped.push_back(i);
        }
        result.trace.push_back(entry);
        if (entry.flipped.empty()) {
            result.layout = std::move(layout);
            break;
        }
        for (int idx : entry.flipped)
            is_long[idx] = true;
    }
    return result;
}

std::optional<LayoutResult> solve_optimal(
    const std::vector<Instruction>& prog, const Encoding& enc) {
    validate(prog);
    std::vector<int> jump_indices;
    for (int i = 0; i < static_cast<int>(prog.size()); ++i)
        if (prog[i].kind == Instruction::Kind::Jump)
            jump_indices.push_back(i);

    const int k = static_cast<int>(jump_indices.size());
    if (k > 20)
        return std::nullopt;

    const std::uint64_t combos = std::uint64_t{1} << k;
    std::optional<LayoutResult> best;
    std::vector<bool> is_long(prog.size(), false);

    for (std::uint64_t mask = 0; mask < combos; ++mask) {
        for (int b = 0; b < k; ++b)
            is_long[jump_indices[b]] = (mask >> b) & 1u;
        LayoutResult layout = compute_layout(prog, enc, is_long);
        if (!layout.feasible)
            continue;
        if (!best || layout.total_length < best->total_length)
            best = std::move(layout);
    }
    return best;
}

bool verify(const std::vector<Instruction>& prog, const Encoding& enc,
            const LayoutResult& layout) {
    if (layout.is_long.size() != prog.size())
        return false;
    LayoutResult recomputed = compute_layout(prog, enc, layout.is_long);
    return recomputed.feasible && recomputed.offsets == layout.offsets &&
           recomputed.displacement == layout.displacement &&
           recomputed.total_length == layout.total_length;
}

std::string render_trace(const SolveResult& result) {
    std::ostringstream out;
    out << "iteration trace (relaxation, all-short start)\n";
    for (const auto& entry : result.trace) {
        out << "  iter " << entry.iteration << ": total=" << entry.total_length
            << "  flipped=[";
        for (std::size_t i = 0; i < entry.flipped.size(); ++i) {
            if (i)
                out << ',';
            out << entry.flipped[i];
        }
        out << ']';
        if (entry.flipped.empty())
            out << "  (fixpoint, all jumps legal)";
        out << '\n';
    }
    return out.str();
}

std::string render_certificate(const std::vector<Instruction>& prog,
                               const LayoutResult& layout) {
    std::ostringstream out;
    out << "offset certificate\n";
    out << "  idx  offset  size  kind   detail\n";
    for (int i = 0; i < static_cast<int>(prog.size()); ++i) {
        const int size = layout.offsets[i + 1] - layout.offsets[i];
        out << "  " << i << "    " << layout.offsets[i] << "      " << size
            << "     ";
        if (prog[i].kind == Instruction::Kind::Fixed) {
            out << "fixed\n";
        } else {
            out << (layout.is_long[i] ? "long   " : "short  ") << "-> insn "
                << prog[i].target << "  disp=" << layout.displacement[i]
                << "  legal\n";
        }
    }
    out << "  end offset (total length) = " << layout.total_length << '\n';
    return out.str();
}

} // namespace asmlayout
