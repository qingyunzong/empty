#pragma once

// Exact convolution of signed 64-bit integer sequences.
//
// Method: number-theoretic transform modulo five 30-bit primes, followed by
// Garner CRT reconstruction into an exact big integer with symmetric (signed)
// lifting. No truncation anywhere: the result is exact iff the modulus product
// M satisfies M > 2 * max|c_k|, which is verified exactly (with big integers)
// at runtime before reconstruction; a std::runtime_error is thrown otherwise.
//
// Bound proof (worst case, enforced dynamically with the actual data):
//   |c_k| <= min(n,m) * max|a_i| * max|b_j|
//         <= 100000 * 2^63 * 2^63            (n + m <= 200000, values int64)
//         <  2^17 * 2^126 = 2^143.
//   M = 998244353 * 1004535809 * 469762049 * 167772161 * 754974721
//     ~ 5.96e43 > 2^145 > 2 * 2^143 > 2 * max|c_k|.
// Hence each residue vector lifts to a unique integer in (-M/2, M/2] that
// equals the true coefficient.

#include <array>
#include <cstdint>
#include <stdexcept>
#include <vector>

#include "bigint.hpp"

namespace conv {

inline constexpr size_t kMaxTotalLength = 200000;

// All primes are of the form c*2^k + 1 with k >= 21 >= log2(max NTT size 2^19),
// so roots of unity of any required order exist.
inline constexpr std::array<uint32_t, 5> kModuli = {
    998244353u,   // 119 * 2^23 + 1
    1004535809u,  // 479 * 2^21 + 1
    469762049u,   //   7 * 2^26 + 1
    167772161u,   //   5 * 2^25 + 1
    754974721u,   //  45 * 2^24 + 1
};

inline uint64_t mod_pow(uint64_t base, uint64_t exp, uint32_t mod) {
    uint64_t r = 1 % mod;
    base %= mod;
    while (exp) {
        if (exp & 1) r = r * base % mod;
        base = base * base % mod;
        exp >>= 1;
    }
    return r;
}

inline uint32_t primitive_root(uint32_t p) {
    uint32_t phi = p - 1;
    std::vector<uint32_t> factors;
    for (uint32_t d = 2, x = phi; static_cast<uint64_t>(d) * d <= x; ++d) {
        if (x % d == 0) {
            factors.push_back(d);
            while (x % d == 0) x /= d;
        }
        if (d * d > x && x > 1) {
            factors.push_back(x);
            break;
        }
    }
    for (uint32_t g = 2;; ++g) {
        bool ok = true;
        for (uint32_t q : factors)
            if (mod_pow(g, phi / q, p) == 1) {
                ok = false;
                break;
            }
        if (ok) return g;
    }
}

inline void ntt(std::vector<uint32_t>& a, bool invert, uint32_t p, uint32_t g) {
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; ++i) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(a[i], a[j]);
    }
    for (size_t len = 2; len <= n; len <<= 1) {
        uint32_t w = static_cast<uint32_t>(mod_pow(g, (p - 1) / len, p));
        if (invert) w = static_cast<uint32_t>(mod_pow(w, p - 2, p));
        for (size_t i = 0; i < n; i += len) {
            uint64_t wn = 1;
            for (size_t k = 0; k < len / 2; ++k) {
                uint64_t u = a[i + k];
                uint64_t v = static_cast<uint64_t>(a[i + k + len / 2]) * wn % p;
                uint64_t x = u + v;
                if (x >= p) x -= p;
                uint64_t y = u + p - v;
                if (y >= p) y -= p;
                a[i + k] = static_cast<uint32_t>(x);
                a[i + k + len / 2] = static_cast<uint32_t>(y);
                wn = wn * w % p;
            }
        }
    }
    if (invert) {
        uint64_t inv_n = mod_pow(n, p - 2, p);
        for (auto& v : a) v = static_cast<uint32_t>(v * inv_n % p);
    }
}

inline uint32_t to_residue(int64_t x, uint32_t p) {
    uint64_t ax = x < 0 ? 0ull - static_cast<uint64_t>(x) : static_cast<uint64_t>(x);
    uint32_t r = static_cast<uint32_t>(ax % p);
    if (x < 0 && r) r = p - r;
    return r;
}

// Exact convolution: returns n + m - 1 big-integer coefficients.
// Throws std::length_error if a.size() + b.size() > kMaxTotalLength.
// Throws std::runtime_error if the CRT modulus product cannot be proven large
// enough for the actual data (cannot happen within the documented limits).
inline std::vector<BigInt> convolution(const std::vector<int64_t>& a,
                                       const std::vector<int64_t>& b) {
    if (a.empty() || b.empty()) return {};
    if (a.size() + b.size() > kMaxTotalLength)
        throw std::length_error("total length exceeds 200000");

    const size_t out_n = a.size() + b.size() - 1;
    size_t n = 1;
    while (n < out_n) n <<= 1;

    // Run the NTT convolution modulo each prime.
    std::array<std::vector<uint32_t>, kModuli.size()> res;
    for (size_t pi = 0; pi < kModuli.size(); ++pi) {
        const uint32_t p = kModuli[pi];
        const uint32_t g = primitive_root(p);
        std::vector<uint32_t> fa(n), fb(n);
        for (size_t i = 0; i < a.size(); ++i) fa[i] = to_residue(a[i], p);
        for (size_t i = 0; i < b.size(); ++i) fb[i] = to_residue(b[i], p);
        ntt(fa, false, p, g);
        ntt(fb, false, p, g);
        for (size_t i = 0; i < n; ++i)
            fa[i] = static_cast<uint32_t>(static_cast<uint64_t>(fa[i]) * fb[i] % p);
        ntt(fa, true, p, g);
        fa.resize(out_n);
        res[pi] = std::move(fa);
    }

    // Modulus product M and its half, as exact big integers.
    BigInt M = BigInt::from_u64(1);
    for (uint32_t p : kModuli) M.mul_u32(p);
    BigInt half_M = M;
    half_M.divmod_small(2);

    // Exact a-priori bound: |c_k| <= min(n,m) * max|a_i| * max|b_j|.
    // Require M > 2 * bound so the symmetric lift is unique and correct.
    uint64_t max_a = 0, max_b = 0;
    for (int64_t x : a) {
        uint64_t ax = x < 0 ? 0ull - static_cast<uint64_t>(x) : static_cast<uint64_t>(x);
        if (ax > max_a) max_a = ax;
    }
    for (int64_t x : b) {
        uint64_t bx = x < 0 ? 0ull - static_cast<uint64_t>(x) : static_cast<uint64_t>(x);
        if (bx > max_b) max_b = bx;
    }
    BigInt bound = BigInt::from_u64(std::min(a.size(), b.size()));
    bound.mul_u64(max_a);
    bound.mul_u64(max_b);
    bound.mul_u32(2);
    if (bound.cmp(M) >= 0)
        throw std::runtime_error("CRT modulus product provably insufficient");

    // Garner CRT constants: inv_m[i] = (m_0 * ... * m_{i-1})^{-1} mod m_i.
    std::array<uint32_t, kModuli.size()> inv_m{};
    for (size_t i = 1; i < kModuli.size(); ++i) {
        uint64_t prod = 1 % kModuli[i];
        for (size_t j = 0; j < i; ++j) prod = prod * kModuli[j] % kModuli[i];
        inv_m[i] = static_cast<uint32_t>(mod_pow(prod, kModuli[i] - 2, kModuli[i]));
    }

    // Reconstruct every coefficient exactly.
    std::vector<BigInt> out(out_n);
    for (size_t k = 0; k < out_n; ++k) {
        BigInt x = BigInt::from_u64(res[0][k]);
        BigInt m_prod = BigInt::from_u64(kModuli[0]);
        for (size_t i = 1; i < kModuli.size(); ++i) {
            const uint32_t p = kModuli[i];
            uint32_t xi = x.mod_small(p);
            uint32_t t = res[i][k] >= xi ? res[i][k] - xi : res[i][k] + p - xi;
            t = static_cast<uint32_t>(static_cast<uint64_t>(t) * inv_m[i] % p);
            x.add_mul_u32(t, m_prod);
            m_prod.mul_u32(p);
        }
        // Symmetric lift into (-M/2, M/2]: exact because M > 2*|c_k|.
        if (x.cmp(half_M) > 0) x.sub(M);
        out[k] = std::move(x);
    }
    return out;
}

}  // namespace conv
