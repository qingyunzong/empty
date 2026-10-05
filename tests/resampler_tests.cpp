// RationalResampler 单元与对照测试。
// 用法： resampler_tests <case_name>   （由 CTest 逐用例驱动）
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <map>
#include <random>
#include <string>
#include <vector>

#include "rational_resampler.hpp"

using audiolib::RationalResampler;
using audiolib::round_half_even_div;
using audiolib::saturate_int16;

static int g_failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);   \
            ++g_failures;                                                 \
        }                                                                 \
    } while (0)

// ---------------- 暴力参考实现（与库定义一致的直接计算） ----------------
static std::vector<std::int16_t> reference_resample(
    std::int64_t up, std::int64_t down, const std::vector<std::int32_t>& coeffs,
    std::int64_t scale, const std::vector<std::int16_t>& in,
    std::int64_t zero_tail) {
    const std::int64_t n = static_cast<std::int64_t>(in.size());
    const std::int64_t total =
        RationalResampler::total_outputs(n, zero_tail, up, down);
    std::vector<std::int16_t> out;
    out.reserve(static_cast<std::size_t>(total));
    for (std::int64_t m = 0; m < total; ++m) {
        const std::int64_t t = m * down;
        const std::int64_t p = t % up;
        const std::int64_t c = t / up;
        std::int64_t acc = 0;
        for (std::int64_t j = p; j < static_cast<std::int64_t>(coeffs.size());
             j += up) {
            const std::int64_t idx = c - (j - p) / up;
            const std::int16_t x =
                (idx >= 0 && idx < n) ? in[static_cast<std::size_t>(idx)] : 0;
            acc += static_cast<std::int64_t>(coeffs[static_cast<std::size_t>(j)]) * x;
        }
        out.push_back(saturate_int16(round_half_even_div(acc, scale)));
    }
    return out;
}

// 以给定切块方案跑完整流程（process* + flush），返回全部输出。
static std::vector<std::int16_t> run_chunked(
    std::int64_t up, std::int64_t down, const std::vector<std::int32_t>& coeffs,
    std::int64_t scale, const std::vector<std::int16_t>& in,
    const std::vector<std::size_t>& chunks, std::size_t zero_tail,
    std::int64_t* blocks_out = nullptr) {
    RationalResampler r(up, down, coeffs, scale);
    std::vector<std::int16_t> out;
    std::size_t pos = 0;
    std::int64_t nb = 0;
    for (std::size_t c : chunks) {
        c = std::min(c, in.size() - pos);
        auto piece = r.process(in.data() + pos, c);
        out.insert(out.end(), piece.begin(), piece.end());
        pos += c;
        ++nb;
        if (pos >= in.size()) break;
    }
    if (pos < in.size()) {
        auto piece = r.process(in.data() + pos, in.size() - pos);
        out.insert(out.end(), piece.begin(), piece.end());
        ++nb;
    }
    auto tail = r.flush(zero_tail);
    out.insert(out.end(), tail.begin(), tail.end());
    if (blocks_out) *blocks_out = nb;
    return out;
}

// ---------------- 用例 1：半偶舍入 ----------------
static int test_rounding() {
    struct { std::int64_t n, d, want; } cases[] = {
        {3, 2, 2},    // 1.5 -> 2（偶）
        {5, 2, 2},    // 2.5 -> 2（偶）
        {7, 2, 4},    // 3.5 -> 4（偶）
        {-3, 2, -2},  // -1.5 -> -2（偶）
        {-5, 2, -2},  // -2.5 -> -2（偶）
        {-7, 2, -4},  // -3.5 -> -4（偶）
        {1, 2, 0}, {2, 2, 1}, {10, 4, 3},   // 2.5 -> 2? 否：10/4=2.5 -> 2
        {-10, 4, -2},                        // -2.5 -> -2
        {6, 4, 2},    // 1.5 -> 2
        {-6, 4, -2},  // -1.5 -> -2
        {9, 4, 2},    // 2.25 -> 2
        {11, 4, 3},   // 2.75 -> 3
        {-9, 4, -2}, {-11, 4, -3},
        {0, 7, 0}, {100, 10, 10}, {-100, 10, -10},
    };
    // 修正上面注释中 10/4 的期望值：2.5 半偶 -> 2
    cases[8].want = 2;
    for (auto& c : cases) {
        const std::int64_t got = round_half_even_div(c.n, c.d);
        if (got != c.want) {
            std::printf("FAIL rounding: %lld/%lld = %lld, want %lld\n",
                        (long long)c.n, (long long)c.d, (long long)got,
                        (long long)c.want);
            ++g_failures;
        }
    }
    std::printf("STATS case=rounding checks=%zu\n", sizeof(cases)/sizeof(cases[0]));
    return g_failures;
}

// ---------------- 用例 2：饱和 ----------------
static int test_saturation() {
    CHECK(saturate_int16(40000) == INT16_MAX);
    CHECK(saturate_int16(-40000) == INT16_MIN);
    CHECK(saturate_int16(123) == 123);
    // 大系数使累加器远超 int16 范围，输出必须被钳位。
    // 8 个输入 + 1 个填尾零 => 9 个输出，每个输出窗口内仍含真实大样本。
    RationalResampler r(1, 1, {100000, 100000}, 1);
    std::vector<std::int16_t> in(8, 30000);
    auto out = r.process(in);
    auto tail = r.flush(1);
    out.insert(out.end(), tail.begin(), tail.end());
    CHECK(out.size() == 9);
    for (auto v : out) CHECK(v == INT16_MAX);
    RationalResampler r2(1, 1, {-100000, -100000}, 1);
    auto out2 = r2.process(in);
    auto tail2 = r2.flush(1);
    out2.insert(out2.end(), tail2.begin(), tail2.end());
    CHECK(out2.size() == 9);
    for (auto v : out2) CHECK(v == INT16_MIN);
    std::printf("STATS case=saturation clipped_pos=%zu clipped_neg=%zu\n",
                out.size(), out2.size());
    return g_failures;
}

// ---------------- 用例 3：恒等与整数延迟 ----------------
static int test_identity_delay() {
    constexpr std::int64_t S = 1 << 15;
    std::mt19937 rng(42);
    std::vector<std::int16_t> in(500);
    for (auto& v : in) v = static_cast<std::int16_t>(rng());
    // 恒等：h = {S}, scale = S
    {
        RationalResampler r(1, 1, {S}, S);
        auto out = r.process(in);
        auto tail = r.flush(0);
        out.insert(out.end(), tail.begin(), tail.end());
        CHECK(out == in);
    }
    // 纯延迟 d=3：h = {0,0,0,S}
    {
        constexpr int d = 3;
        RationalResampler r(1, 1, {0, 0, 0, S}, S);
        auto out = r.process(in);
        auto tail = r.flush(d);  // 填尾 d 个零以取回全部延迟样本
        out.insert(out.end(), tail.begin(), tail.end());
        CHECK(out.size() == in.size() + d);
        for (std::size_t i = 0; i < in.size(); ++i) CHECK(out[i + d] == in[i]);
        for (int i = 0; i < d; ++i) CHECK(out[static_cast<std::size_t>(i)] == 0);
        std::printf("STATS case=delay group_delay=%d recovered=%zu\n", d,
                    in.size());
    }
    return g_failures;
}

// ---------------- 用例 4：切块 vs 一次性 + 参考对照 ----------------
static int test_chunked_vs_oneshot() {
    struct Cfg {
        std::int64_t up, down;
        std::vector<std::int32_t> coeffs;
        std::int64_t scale;
        std::size_t n_in, zero_tail;
    };
    const std::int64_t S = 1 << 15;
    std::vector<Cfg> cfgs = {
        {3, 2, {1800, 9200, 16384, 9200, 1800}, 32768, 1000, 4},
        {2, 3, {5000, 16384, 5000}, 32768, 999, 3},
        {1, 4, {4096, 8192, 8192, 4096}, 24576, 777, 0},
        {4, 1, {1024, 2048, 4096, 8192, 4096, 2048, 1024}, 19456, 513, 7},
        {147, 160, {300, 1200, 3100, 5900, 8200, 8200, 5900, 3100, 1200, 300},
         34100, 640, 11},
        {1, 1, {S / 4, S / 2, S / 4}, S, 256, 2},
        {5, 7, {-1000, 4000, 9000, 4000, -1000}, 16000, 350, 9},
    };
    std::mt19937 rng(20261005);
    int cfg_idx = 0;
    for (const auto& cfg : cfgs) {
        std::vector<std::int16_t> in(cfg.n_in);
        for (auto& v : in) v = static_cast<std::int16_t>(rng());
        // 一次性
        std::int64_t nb1 = 0;
        auto one = run_chunked(cfg.up, cfg.down, cfg.coeffs, cfg.scale, in,
                               {cfg.n_in}, cfg.zero_tail, &nb1);
        // 参考实现
        auto ref = reference_resample(cfg.up, cfg.down, cfg.coeffs, cfg.scale,
                                      in, static_cast<std::int64_t>(cfg.zero_tail));
        CHECK(one == ref);
        // 多种随机切块
        for (int trial = 0; trial < 8; ++trial) {
            std::vector<std::size_t> chunks;
            std::size_t left = cfg.n_in;
            while (left > 0) {
                std::size_t c = 1 + rng() % 97;
                c = std::min(c, left);
                chunks.push_back(c);
                left -= c;
            }
            std::int64_t nb = 0;
            auto got = run_chunked(cfg.up, cfg.down, cfg.coeffs, cfg.scale, in,
                                   chunks, cfg.zero_tail, &nb);
            if (got != one) {
                std::printf("FAIL chunked mismatch cfg=%d trial=%d\n", cfg_idx,
                            trial);
                ++g_failures;
            }
        }
        const std::int64_t expect = RationalResampler::total_outputs(
            static_cast<std::int64_t>(cfg.n_in),
            static_cast<std::int64_t>(cfg.zero_tail), cfg.up, cfg.down);
        CHECK(static_cast<std::int64_t>(one.size()) == expect);
        std::printf(
            "STATS case=chunked cfg=%d ratio=%lld/%lld taps=%zu in=%zu tail=%zu "
            "out=%zu trials=8 match=yes\n",
            cfg_idx, (long long)cfg.up, (long long)cfg.down, cfg.coeffs.size(),
            cfg.n_in, cfg.zero_tail, one.size());
        ++cfg_idx;
    }
    return g_failures;
}

// ---------------- 用例 5：零填尾语义 ----------------
static int test_zero_tail() {
    const std::int64_t S = 1 << 15;
    std::vector<std::int32_t> h = {1000, 5000, 9000, 5000, 1000};
    std::mt19937 rng(7);
    std::vector<std::int16_t> in(120);
    for (auto& v : in) v = static_cast<std::int16_t>(rng());
    for (std::size_t z : {0UL, 1UL, 2UL, 5UL, 13UL}) {
        // 方式 A：flush(z) 填尾
        auto a = run_chunked(3, 2, h, S, in, {in.size()}, z);
        // 方式 B：显式在输入末尾补 z 个零，flush(0)
        std::vector<std::int16_t> inz = in;
        inz.resize(in.size() + z, 0);
        auto b = run_chunked(3, 2, h, S, inz, {inz.size()}, 0);
        // 两者前缀（A 的全部输出）必须逐样本一致；B 可能因 ceil 多出一帧
        CHECK(a.size() <= b.size());
        CHECK(b.size() - a.size() <= 1);
        for (std::size_t i = 0; i < a.size(); ++i) CHECK(a[i] == b[i]);
        const std::int64_t expect = RationalResampler::total_outputs(
            120, static_cast<std::int64_t>(z), 3, 2);
        CHECK(static_cast<std::int64_t>(a.size()) == expect);
        std::printf("STATS case=zero_tail z=%zu out=%zu expect=%lld\n", z,
                    a.size(), (long long)expect);
    }
    return g_failures;
}

// ---------------- 用例 6：直流保持 ----------------
static int test_dc() {
    // 每个多相分支系数和相等（相位0: 600+2400，相位1: 2400+600），
    // 故直流输入经有理比 2/3 重采样后稳态输出精确等于直流值。
    std::vector<std::int32_t> h = {600, 2400, 2400, 600};
    const std::int64_t phase_sum = 3000;
    RationalResampler r(2, 3, h, phase_sum);
    std::vector<std::int16_t> in(600, 12345);
    auto out = r.process(in);
    auto tail = r.flush(8);
    out.insert(out.end(), tail.begin(), tail.end());
    // 稳态内部样本必须精确等于直流值（边缘因零填充除外）。
    std::size_t edge = 8;
    for (std::size_t i = edge; i + edge < out.size(); ++i)
        CHECK(out[i] == 12345);
    std::printf("STATS case=dc phase_sum=%lld steady=%zu/%zu\n",
                (long long)phase_sum, out.size() - 2 * edge, out.size());
    return g_failures;
}

int main(int argc, char** argv) {
    const std::map<std::string, std::function<int()>> cases = {
        {"rounding", test_rounding},
        {"saturation", test_saturation},
        {"identity_delay", test_identity_delay},
        {"chunked_vs_oneshot", test_chunked_vs_oneshot},
        {"zero_tail", test_zero_tail},
        {"dc", test_dc},
    };
    if (argc != 2 || !cases.count(argv[1])) {
        std::fprintf(stderr, "usage: %s <case>\n", argv[0]);
        for (auto& [k, _] : cases) std::fprintf(stderr, "  %s\n", k.c_str());
        return 2;
    }
    const int fails = cases.at(argv[1])();
    std::printf("%s: %s\n", argv[1], fails == 0 ? "PASS" : "FAIL");
    return fails == 0 ? 0 : 1;
}
