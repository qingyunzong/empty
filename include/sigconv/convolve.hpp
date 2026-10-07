#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "sigconv/bigint.hpp"

namespace sigconv {

struct NttPrime {
    uint32_t p;
    uint32_t g; // primitive root
};

// NTT-friendly primes, each supporting transform lengths up to at least 2^21.
inline constexpr NttPrime kNttPrimes[] = {
    {998244353u, 3u},  // 119 * 2^23 + 1
    {1004535809u, 3u}, // 479 * 2^21 + 1
    {469762049u, 3u},  //   7 * 2^26 + 1
    {167772161u, 3u},  //   5 * 2^25 + 1
    {754974721u, 11u}, //  45 * 2^24 + 1
    {897581057u, 3u},  // 107 * 2^23 + 1
};
inline constexpr size_t kNumNttPrimes = sizeof(kNttPrimes) / sizeof(kNttPrimes[0]);

inline uint32_t powmod(uint32_t a, uint64_t e, uint32_t m) {
    uint64_t r = 1, b = a % m;
    while (e != 0) {
        if (e & 1) r = r * b % m;
        b = b * b % m;
        e >>= 1;
    }
    return static_cast<uint32_t>(r);
}

inline void ntt(std::vector<uint32_t>& a, bool invert, const NttPrime& pr) {
    const uint32_t p = pr.p;
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; ++i) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(a[i], a[j]);
    }
    for (size_t len = 2; len <= n; len <<= 1) {
        uint32_t wlen = powmod(pr.g, (p - 1) / len, p);
        if (invert) wlen = powmod(wlen, p - 2, p);
        for (size_t i = 0; i < n; i += len) {
            uint64_t w = 1;
            for (size_t j = 0; j < len / 2; ++j) {
                uint32_t u = a[i + j];
                uint32_t v = static_cast<uint32_t>(static_cast<uint64_t>(a[i + j + len / 2]) * w % p);
                uint32_t x = u + v;
                if (x >= p) x -= p;
                a[i + j] = x;
                a[i + j + len / 2] = u >= v ? u - v : u + p - v;
                w = w * wlen % p;
            }
        }
    }
    if (invert) {
        uint32_t inv_n = powmod(static_cast<uint32_t>(n), p - 2, p);
        for (auto& v : a) v = static_cast<uint32_t>(static_cast<uint64_t>(v) * inv_n % p);
    }
}

// Exact convolution mod pr.p of two int64 sequences (inputs reduced mod p).
inline std::vector<uint32_t> convolve_prime(const std::vector<int64_t>& A,
                                            const std::vector<int64_t>& B,
                                            const NttPrime& pr, size_t size) {
    std::vector<uint32_t> fa(size, 0), fb(size, 0);
    for (size_t i = 0; i < A.size(); ++i) {
        int64_t r = A[i] % pr.p;
        fa[i] = static_cast<uint32_t>(r < 0 ? r + pr.p : r);
    }
    for (size_t i = 0; i < B.size(); ++i) {
        int64_t r = B[i] % pr.p;
        fb[i] = static_cast<uint32_t>(r < 0 ? r + pr.p : r);
    }
    ntt(fa, false, pr);
    ntt(fb, false, pr);
    for (size_t i = 0; i < size; ++i)
        fa[i] = static_cast<uint32_t>(static_cast<uint64_t>(fa[i]) * fb[i] % pr.p);
    ntt(fa, true, pr);
    fa.resize(A.size() + B.size() - 1);
    return fa;
}

struct ConvolveReport {
    BigUInt modulus;   // M = product of the primes actually used
    BigUInt bound;     // B = min(n,m) * max|a| * max|b|, upper bound on |coefficient|
    size_t num_primes; // primes selected so that M > 2B
    size_t ntt_size;
};

struct ExactConvolution {
    std::vector<BigInt> coeffs;
    ConvolveReport report;
};

inline uint64_t abs_i64(int64_t v) {
    return v < 0 ? uint64_t(0) - static_cast<uint64_t>(v) : static_cast<uint64_t>(v);
}

// Exact convolution of two signed 64-bit sequences.
//
// Correctness argument (no truncation anywhere):
//   Every output coefficient c_k is a sum of at most L = min(n, m) products,
//   each bounded by amax * bmax in absolute value, so |c_k| <= B = L*amax*bmax.
//   We select NTT primes p_1..p_k with M = prod p_i > 2B (verified at runtime;
//   throws if the prime pool is insufficient). Each NTT yields c_k mod p_i
//   exactly. CRT then recovers the unique x in [0, M) with x == c_k (mod M).
//   Since |c_k| <= B < M/2, c_k = x when x <= M/2 and c_k = x - M otherwise,
//   which is the exact integer value.
inline ExactConvolution convolve_exact(const std::vector<int64_t>& A,
                                       const std::vector<int64_t>& B) {
    if (A.empty() || B.empty()) throw std::invalid_argument("sequences must be non-empty");

    const size_t out_len = A.size() + B.size() - 1;
    const uint64_t L = static_cast<uint64_t>(std::min(A.size(), B.size()));
    uint64_t amax = 0, bmax = 0;
    for (int64_t v : A) amax = std::max(amax, abs_i64(v));
    for (int64_t v : B) bmax = std::max(bmax, abs_i64(v));

    BigUInt bound = BigUInt::mul_u64(BigUInt::mul_u64(BigUInt(L), amax), bmax);
    BigUInt two_bound = bound;
    two_bound.add(bound);

    // Select enough primes so that M > 2B.
    BigUInt modulus(1);
    size_t num_primes = 0;
    while (modulus.cmp(two_bound) <= 0) {
        if (num_primes == kNumNttPrimes)
            throw std::runtime_error("modulus pool exhausted: cannot guarantee exact reconstruction");
        modulus = BigUInt::mul_u64(modulus, kNttPrimes[num_primes].p);
        ++num_primes;
    }

    size_t ntt_size = 1;
    while (ntt_size < out_len) ntt_size <<= 1;
    for (size_t i = 0; i < num_primes; ++i) {
        if ((kNttPrimes[i].p - 1) % ntt_size != 0)
            throw std::runtime_error("transform length not supported by selected prime");
    }

    // Residues of every coefficient modulo each selected prime.
    std::vector<std::vector<uint32_t>> residues(num_primes);
    for (size_t i = 0; i < num_primes; ++i)
        residues[i] = convolve_prime(A, B, kNttPrimes[i], ntt_size);

    // invprod[i] = (p_0 * ... * p_{i-1})^{-1} mod p_i  (Garner's algorithm).
    std::vector<uint32_t> invprod(num_primes, 1);
    for (size_t i = 0; i < num_primes; ++i) {
        uint64_t prod = 1;
        for (size_t j = 0; j < i; ++j) prod = prod * (kNttPrimes[j].p % kNttPrimes[i].p) % kNttPrimes[i].p;
        invprod[i] = powmod(static_cast<uint32_t>(prod), kNttPrimes[i].p - 2, kNttPrimes[i].p);
    }

    ExactConvolution result;
    result.coeffs.resize(out_len);
    for (size_t k = 0; k < out_len; ++k) {
        BigUInt x;       // reconstructed value in [0, M)
        BigUInt pprod(1); // p_0 * ... * p_{i-1}
        for (size_t i = 0; i < num_primes; ++i) {
            const uint32_t pi = kNttPrimes[i].p;
            int64_t t = static_cast<int64_t>(residues[i][k]) - x.mod_u32(pi);
            t %= pi;
            if (t < 0) t += pi;
            t = static_cast<uint64_t>(t) * invprod[i] % pi;
            if (t != 0) x.add(BigUInt::mul_u64(pprod, static_cast<uint64_t>(t)));
            pprod = BigUInt::mul_u64(pprod, pi);
        }
        // Map x from [0, M) to (-M/2, M/2]: negative iff 2x > M.
        BigUInt two_x = x;
        two_x.add(x);
        if (two_x.cmp(modulus) > 0) {
            BigUInt mag = modulus;
            mag.sub(x);
            result.coeffs[k] = BigInt{true, mag};
        } else {
            result.coeffs[k] = BigInt{false, x};
        }
    }

    result.report = ConvolveReport{modulus, bound, num_primes, ntt_size};
    return result;
}

} // namespace sigconv
