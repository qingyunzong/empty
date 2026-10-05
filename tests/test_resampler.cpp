#include "audio_resample/resampler.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <random>
#include <string>
#include <vector>

using audio_resample::Resampler;
using audio_resample::quantizeHalfEven;

static int failures = 0;

#define CHECK(cond)                                                                              \
    do {                                                                                         \
        if (!(cond)) {                                                                           \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #cond "\n";             \
            ++failures;                                                                          \
        }                                                                                        \
    } while (0)

static std::uint64_t checksum(const std::vector<std::int16_t>& v) {
    std::uint64_t h = 1469598103934665603ull;
    for (std::int16_t s : v) {
        h ^= static_cast<std::uint16_t>(s);
        h *= 1099511628211ull;
    }
    return h;
}

// 与库无关的直写参考实现:输入末尾恰好补 zeroPad 个零,相位从 0 起步。
static std::vector<std::int16_t> referenceResample(const std::vector<std::int16_t>& in,
                                                   std::size_t zeroPad, int up, int down,
                                                   std::vector<std::int32_t> coeffs,
                                                   std::int64_t scale) {
    const int taps = static_cast<int>((coeffs.size() + up - 1) / up);
    coeffs.resize(static_cast<std::size_t>(taps) * up, 0);
    const std::int64_t total = static_cast<std::int64_t>(in.size()) +
                               static_cast<std::int64_t>(zeroPad);
    std::vector<std::int16_t> out;
    int phase = 0;
    std::int64_t idx = taps - 1;
    while (idx < total) {
        std::int64_t acc = 0;
        for (int k = 0; k < taps; ++k) {
            const std::int64_t pos = idx - k;
            const std::int16_t x =
                pos < static_cast<std::int64_t>(in.size()) ? in[static_cast<std::size_t>(pos)] : 0;
            acc += static_cast<std::int64_t>(coeffs[static_cast<std::size_t>(phase + k * up)]) * x;
        }
        out.push_back(quantizeHalfEven(acc, scale));
        phase += down;
        idx += phase / up;
        phase %= up;
    }
    return out;
}

// 闭式输出样本数:idx_n = taps-1 + floor(n*down/up) <= total-1
// 即 floor(n*down/up) <= room 的 n 个数 = floor(((room+1)*up - 1)/down) + 1
static std::int64_t expectedCount(std::int64_t total, int taps, int up, int down) {
    const std::int64_t room = (total - 1) - (taps - 1);
    if (room < 0) return 0;
    return ((room + 1) * up - 1) / down + 1;
}

static std::vector<std::int16_t> runChunked(int up, int down,
                                            const std::vector<std::int32_t>& coeffs,
                                            std::int64_t scale,
                                            const std::vector<std::int16_t>& in,
                                            std::size_t chunk, std::size_t zeroPad) {
    Resampler r(up, down, coeffs, scale);
    std::vector<std::int16_t> out;
    for (std::size_t i = 0; i < in.size(); i += chunk) {
        const std::size_t n = std::min(chunk, in.size() - i);
        r.process(std::span<const std::int16_t>(in.data() + i, n), out);
    }
    r.finish(zeroPad, out);
    return out;
}

static std::vector<std::int32_t> makeCoeffs(std::size_t n, std::uint32_t seed) {
    std::mt19937 rng(seed);
    std::uniform_int_distribution<std::int32_t> dist(-70000, 70000);
    std::vector<std::int32_t> c(n);
    for (auto& v : c) v = dist(rng);
    return c;
}

static std::vector<std::int16_t> makeInput(std::size_t n, std::uint32_t seed) {
    std::mt19937 rng(seed);
    std::uniform_int_distribution<int> dist(-30000, 30000);
    std::vector<std::int16_t> x(n);
    for (auto& v : x) v = static_cast<std::int16_t>(dist(rng));
    return x;
}

static void testQuantize() {
    // 半偶舍入:0.5->0, 1.5->2, 2.5->2, 3.5->4,负数对称
    CHECK(quantizeHalfEven(1, 2) == 0);
    CHECK(quantizeHalfEven(3, 2) == 2);
    CHECK(quantizeHalfEven(5, 2) == 2);
    CHECK(quantizeHalfEven(7, 2) == 4);
    CHECK(quantizeHalfEven(-1, 2) == 0);
    CHECK(quantizeHalfEven(-3, 2) == -2);
    CHECK(quantizeHalfEven(-5, 2) == -2);
    CHECK(quantizeHalfEven(-7, 2) == -4);
    // 非一半情形四舍五入
    CHECK(quantizeHalfEven(13, 10) == 1);
    CHECK(quantizeHalfEven(15, 10) == 2); // 1.5 -> 2(偶)
    CHECK(quantizeHalfEven(25, 10) == 2); // 2.5 -> 2(偶)
    CHECK(quantizeHalfEven(35, 10) == 4); // 3.5 -> 4(偶)
    CHECK(quantizeHalfEven(-15, 10) == -2);
    CHECK(quantizeHalfEven(-25, 10) == -2);
    // 饱和
    CHECK(quantizeHalfEven(40000, 1) == 32767);
    CHECK(quantizeHalfEven(-40000, 1) == -32768);
    CHECK(quantizeHalfEven(32767, 1) == 32767);
    CHECK(quantizeHalfEven(-32768, 1) == -32768);
    std::cout << "[quantize] 18 cases checked\n";
}

static void testIdentity() {
    const std::int64_t scale = 1 << 15;
    const std::vector<std::int32_t> coeffs = {static_cast<std::int32_t>(scale)};
    const auto in = makeInput(500, 42);
    const auto out = runChunked(1, 1, coeffs, scale, in, 7, 0);
    CHECK(out == in);
    std::cout << "[identity] 500 samples, out==in: " << (out == in ? "yes" : "no") << "\n";
}

static void testChunkInvariance() {
    const std::int64_t scale = 1 << 15;
    const int rates[][2] = {{3, 2}, {2, 3}, {1, 4}, {4, 1}, {5, 7}, {7, 5}, {1, 1}};
    const std::size_t chunks[] = {1, 2, 3, 7, 31, 128, 1000};
    const auto in = makeInput(1000, 1234);
    const std::size_t zeroPad = 53;
    for (const auto& rate : rates) {
        const auto coeffs = makeCoeffs(47, 1000 + static_cast<std::uint32_t>(rate[0] * 16 + rate[1]));
        const auto oneShot = runChunked(rate[0], rate[1], coeffs, scale, in, in.size(), zeroPad);
        const auto ref = referenceResample(in, zeroPad, rate[0], rate[1], coeffs, scale);
        CHECK(oneShot == ref);
        const int taps = static_cast<int>((coeffs.size() + rate[0] - 1) / rate[0]);
        CHECK(static_cast<std::int64_t>(oneShot.size()) ==
              expectedCount(1000 + 53, taps, rate[0], rate[1]));
        for (const std::size_t chunk : chunks) {
            const auto got = runChunked(rate[0], rate[1], coeffs, scale, in, chunk, zeroPad);
            CHECK(got == oneShot);
        }
        std::cout << "[chunk] rate=" << rate[0] << "/" << rate[1] << " outputs=" << oneShot.size()
                  << " checksum=" << checksum(oneShot) << " all 7 chunkings identical\n";
    }
}

static void testZeroTail() {
    const std::int64_t scale = 1 << 15;
    const auto coeffs = makeCoeffs(23, 77);
    const auto in = makeInput(300, 88);
    const auto out0 = runChunked(3, 2, coeffs, scale, in, 300, 0);
    const auto out5 = runChunked(3, 2, coeffs, scale, in, 300, 5);
    const auto out40 = runChunked(3, 2, coeffs, scale, in, 300, 40);
    // 前缀性质:补零只追加输出,不改变已有样本
    CHECK(out5.size() >= out0.size());
    CHECK(out40.size() >= out5.size());
    CHECK(std::vector<std::int16_t>(out5.begin(), out5.begin() + out0.size()) == out0);
    CHECK(std::vector<std::int16_t>(out40.begin(), out40.begin() + out5.size()) == out5);
    // 与参考实现逐样本一致(即:尾部恰好只有指定的 zeroPad 个零起作用)
    CHECK(out0 == referenceResample(in, 0, 3, 2, coeffs, scale));
    CHECK(out5 == referenceResample(in, 5, 3, 2, coeffs, scale));
    CHECK(out40 == referenceResample(in, 40, 3, 2, coeffs, scale));
    // 库内"process 手动补零 + finish(0)"与"finish(zeroPad)"等价
    {
        Resampler r(3, 2, coeffs, scale);
        std::vector<std::int16_t> manual;
        r.process(in, manual);
        const std::vector<std::int16_t> zeros(5, 0);
        r.process(zeros, manual);
        r.finish(0, manual);
        CHECK(manual == out5);
    }
    std::cout << "[zero_tail] counts z=0:" << out0.size() << " z=5:" << out5.size()
              << " z=40:" << out40.size() << " prefix+reference ok\n";
}

static void testImpulseDelay() {
    const std::int64_t scale = 1 << 15;
    // 线性相位对称 FIR,长度 49(非 3 的倍数,触发系数补零)
    std::vector<std::int32_t> coeffs(49);
    for (int i = 0; i < 49; ++i) {
        const int d = i - 24;
        coeffs[static_cast<std::size_t>(i)] = 4000 - d * d * 6; // 中心 24 处最大
    }
    std::vector<std::int16_t> in(200, 0);
    in[10] = 32767;
    auto peakIndex = [](const std::vector<std::int16_t>& v) {
        std::size_t best = 0;
        for (std::size_t i = 1; i < v.size(); ++i)
            if (std::abs(v[i]) > std::abs(v[best])) best = i;
        return best;
    };
    const auto oneShot = runChunked(3, 2, coeffs, scale, in, in.size(), 60);
    const std::size_t peak = peakIndex(oneShot);
    for (const std::size_t chunk : {1ul, 7ul, 50ul, 200ul}) {
        const auto got = runChunked(3, 2, coeffs, scale, in, chunk, 60);
        CHECK(got == oneShot);
        CHECK(peakIndex(got) == peak);
    }
    // 理论峰值位置:中心抽头 c=24 在分支 p=c%3=0、k=c/3=8;
    // 需要 idx_n = 10 + 8 = 18 且 phase_n = 0。idx_n = 16 + floor(2n/3),得 n = 3。
    CHECK(peak == 3);
    // 峰值幅度:32767 * h[24] / scale 半偶舍入
    CHECK(oneShot[peak] == quantizeHalfEven(32767ll * coeffs[24], scale));
    std::cout << "[impulse] peak at output " << peak << " amplitude " << oneShot[peak]
              << " total outputs " << oneShot.size() << " identical across chunkings\n";
}

static void testSaturation() {
    const std::int64_t scale = 1 << 15;
    const std::vector<std::int32_t> coeffs = {static_cast<std::int32_t>(2 * scale)};
    const std::vector<std::int16_t> in = {20000, -20000, 16383, -16384, 100, -100};
    const auto out = runChunked(1, 1, coeffs, scale, in, in.size(), 0);
    CHECK(out.size() == in.size());
    CHECK(out[0] == 32767);   // 40000 饱和
    CHECK(out[1] == -32768);  // -40000 饱和
    CHECK(out[2] == 32766);   // 32766 不饱和
    CHECK(out[3] == -32768);  // 恰好在边界
    CHECK(out[4] == 200);
    CHECK(out[5] == -200);
    std::cout << "[saturation] 40000->32767, -40000->-32768, boundary 16384*-2=-32768 ok\n";
}

static void testGuards() {
    Resampler r(3, 2, {1, 2, 3}, 1);
    std::vector<std::int16_t> out;
    const std::vector<std::int16_t> in(10, 1);
    r.process(in, out);
    r.finish(4, out);
    bool threw = false;
    try {
        r.process(in, out);
    } catch (const std::logic_error&) {
        threw = true;
    }
    CHECK(threw);
    threw = false;
    try {
        r.finish(1, out);
    } catch (const std::logic_error&) {
        threw = true;
    }
    CHECK(threw);
    threw = false;
    try {
        Resampler bad(0, 2, {1}, 1);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
    std::cout << "[guards] process-after-finish, double-finish, invalid-args all throw\n";
}

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: " << argv[0] << " <test-name>\n";
        return 2;
    }
    const std::string name = argv[1];
    if (name == "quantize") testQuantize();
    else if (name == "identity") testIdentity();
    else if (name == "chunk_invariance") testChunkInvariance();
    else if (name == "zero_tail") testZeroTail();
    else if (name == "impulse_delay") testImpulseDelay();
    else if (name == "saturation") testSaturation();
    else if (name == "guards") testGuards();
    else {
        std::cerr << "unknown test: " << name << "\n";
        return 2;
    }
    if (failures != 0) {
        std::cerr << name << ": " << failures << " failure(s)\n";
        return 1;
    }
    std::cout << name << ": PASS\n";
    return 0;
}
