#pragma once

#include <optional>
#include <string>
#include <vector>

namespace asmlayout {

// One assembly instruction: either a fixed-size instruction or a relative
// jump to another instruction index. A jump can be encoded "short" (small
// size, limited displacement range) or "long" (large size, always legal).
struct Instruction {
    enum class Kind { Fixed, Jump };

    Kind kind = Kind::Fixed;
    int fixed_size = 0; // valid when kind == Kind::Fixed
    int target = 0;     // valid when kind == Kind::Jump (instruction index)

    static Instruction fixed(int size);
    static Instruction jump(int target);
};

// Encoding parameters (x86-like defaults: rel8 vs rel32 near jumps).
struct Encoding {
    int short_size = 2;
    int long_size = 5;
    int short_min = -128; // displacement measured from end of the jump insn
    int short_max = 127;
};

// A full layout: offsets, encoding choice and displacement per instruction.
struct LayoutResult {
    std::vector<int> offsets;      // size n+1; offsets[i] = start of insn i
    std::vector<bool> is_long;     // size n; meaningful for jumps
    std::vector<int> displacement; // size n; meaningful for jumps
    bool feasible = false;         // every jump legal under its encoding
    int total_length = 0;
};

// One relaxation iteration: which jumps flipped short -> long.
struct TraceEntry {
    int iteration = 0;
    std::vector<int> flipped; // instruction indices flipped this iteration
    int total_length = 0;     // total length at the start of this iteration
};

struct SolveResult {
    LayoutResult layout;
    std::vector<TraceEntry> trace;
};

// Validate structural constraints (sizes > 0, jump targets in range).
void validate(const std::vector<Instruction>& prog);

// Compute the layout induced by an encoding choice, checking legality.
LayoutResult compute_layout(const std::vector<Instruction>& prog,
                            const Encoding& enc,
                            const std::vector<bool>& is_long);

// Iterative relaxation: start all-short, grow illegal jumps until fixpoint.
// Because growing an instruction never shrinks any displacement magnitude,
// the grown set is a subset of every feasible solution's grown set, so the
// fixpoint is optimal. The trace records every iteration.
SolveResult solve_relaxation(const std::vector<Instruction>& prog,
                             const Encoding& enc);

// Exact optimum by enumerating all 2^k short/long combinations (k = #jumps).
// Returns std::nullopt when k > 20 (the supported enumeration limit).
std::optional<LayoutResult> solve_optimal(const std::vector<Instruction>& prog,
                                          const Encoding& enc);

// Recompute everything from `layout.is_long` and confirm the certificate is
// self-consistent (offsets, displacements, legality, total length).
bool verify(const std::vector<Instruction>& prog, const Encoding& enc,
            const LayoutResult& layout);

std::string render_trace(const SolveResult& result);
std::string render_certificate(const std::vector<Instruction>& prog,
                               const LayoutResult& layout);

} // namespace asmlayout
