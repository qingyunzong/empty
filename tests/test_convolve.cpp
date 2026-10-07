#include <cstdint>
#include <cstdio>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "sigconv/convolve.hpp"

using sigconv::BigInt;
using sigconv::BigUInt;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    if (!ok) {
        std::cerr << "FAIL: " << what << "\n";
        ++g_failures;
    }
}

BigInt bigint_add(const BigInt& x, const BigInt& y) {
    BigInt r;
    if (x.neg == y.neg) {
        r.neg = x.neg;
        r.mag = x.mag;
        r.mag.add(y.mag);
    } else {
        int c = x.mag.cmp(y.mag);
        if (c == 0) return BigInt{};
        if (c > 0) {
            r.neg = x.neg;
            r.mag = x.mag;
            r.mag.sub(y.mag);
        } else {
            r.neg = y.neg;
            r.mag = y.mag;
            r.mag.sub(x.mag);
        }
    }
    return r;
}

// O(n*m) exact reference convolution.
std::vector<BigInt> ref_convolve(const std::vector<int64_t>& A, const std::vector<int64_t>& B) {
    std::vector<BigInt> c(A.size() + B.size() - 1);
    for (size_t i = 0; i < A.size(); ++i) {
        for (size_t j = 0; j < B.size(); ++j) {
            BigInt term;
            term.neg = (A[i] < 0) != (B[j] < 0);
            term.mag = BigUInt::mul_u64(BigUInt(sigconv::abs_i64(A[i])), sigconv::abs_i64(B[j]));
            c[i + j] = bigint_add(c[i + j], term);
        }
    }
    return c;
}

void compare_with_ref(const std::vector<int64_t>& A, const std::vector<int64_t>& B,
                      const std::string& tag) {
    auto got = sigconv::convolve_exact(A, B);
    auto want = ref_convolve(A, B);
    check(got.coeffs.size() == want.size(), tag + ": length mismatch");
    // The runtime proof obligation: modulus must exceed twice the bound.
    check(got.report.modulus.cmp([&] {
        BigUInt t = got.report.bound;
        t.add(got.report.bound);
        return t;
    }()) > 0,
          tag + ": modulus not greater than 2*bound");
    for (size_t k = 0; k < want.size(); ++k) {
        if (got.coeffs[k].to_string() != want[k].to_string()) {
            check(false, tag + ": coeff " + std::to_string(k) + " got " +
                             got.coeffs[k].to_string() + " want " + want[k].to_string());
            return;
        }
    }
}

void test_primitive_roots() {
    // Every declared primitive root must actually have order p-1, and each
    // prime must support the maximum transform length we may request (2^21).
    for (const auto& pr : sigconv::kNttPrimes) {
        check(sigconv::powmod(pr.g, pr.p - 1, pr.p) == 1,
              "root fails Fermat: " + std::to_string(pr.p));
        uint32_t w = sigconv::powmod(pr.g, (pr.p - 1) >> 21, pr.p);
        check(sigconv::powmod(w, 1u << 21, pr.p) == 1,
              "no 2^21-th root of unity: " + std::to_string(pr.p));
        check(sigconv::powmod(w, 1u << 20, pr.p) != 1,
              "root of unity has too small order: " + std::to_string(pr.p));
    }
    std::cout << "primitive root tests done\n";
}

void test_random() {
    std::mt19937_64 rng(20261008);
    const int64_t specials[] = {INT64_MAX, INT64_MIN, 0, 1, -1, INT64_MAX - 1, INT64_MIN + 1};
    for (int iter = 0; iter < 300; ++iter) {
        size_t n = 1 + rng() % 40, m = 1 + rng() % 40;
        std::vector<int64_t> A(n), B(m);
        int mode = iter % 3;
        for (auto& v : A) {
            if (rng() % 4 == 0) v = specials[rng() % 7];
            else if (mode == 0) v = static_cast<int64_t>(rng());
            else if (mode == 1) v = static_cast<int64_t>(rng() % 2001) - 1000;
            else v = (rng() & 1) ? INT64_MAX : INT64_MIN;
        }
        for (auto& v : B) {
            if (rng() % 4 == 0) v = specials[rng() % 7];
            else if (mode == 0) v = static_cast<int64_t>(rng());
            else if (mode == 1) v = static_cast<int64_t>(rng() % 2001) - 1000;
            else v = (rng() & 1) ? INT64_MAX : INT64_MIN;
        }
        compare_with_ref(A, B, "random iter " + std::to_string(iter));
    }
    std::cout << "random tests done\n";
}

void test_extremes() {
    const int64_t M = INT64_MAX, m = INT64_MIN;

    // All-max / all-min sequences, mixed signs.
    compare_with_ref(std::vector<int64_t>(30, M), std::vector<int64_t>(25, M), "all MAX");
    compare_with_ref(std::vector<int64_t>(30, m), std::vector<int64_t>(25, m), "all MIN");
    compare_with_ref(std::vector<int64_t>(30, M), std::vector<int64_t>(25, m), "MAX x MIN");

    // Alternating extremes: heavy positive/negative cancellation.
    std::vector<int64_t> alt1(31), alt2(29);
    for (size_t i = 0; i < alt1.size(); ++i) alt1[i] = (i % 2) ? m : M;
    for (size_t i = 0; i < alt2.size(); ++i) alt2[i] = (i % 2) ? M : m;
    compare_with_ref(alt1, alt2, "alternating extremes");

    // Exact cancellation: [MAX, -MAX] * [MAX, MAX] = [MAX^2, 0, -MAX^2].
    auto r = sigconv::convolve_exact({M, -M}, {M, M});
    check(r.coeffs.size() == 3, "cancel: length");
    check(r.coeffs[0].to_string() == "85070591730234615847396907784232501249",
          "cancel: c0 = MAX^2, got " + r.coeffs[0].to_string());
    check(r.coeffs[1].to_string() == "0", "cancel: c1 must be exactly 0, got " +
                                              r.coeffs[1].to_string());
    check(r.coeffs[2].to_string() == "-85070591730234615847396907784232501249",
          "cancel: c2 = -MAX^2, got " + r.coeffs[2].to_string());

    // INT64_MIN^2 = 2^126 exactly.
    auto r2 = sigconv::convolve_exact({m}, {m});
    check(r2.coeffs[0].to_string() == "85070591730234615865843651857942052864",
          "MIN^2 = 2^126, got " + r2.coeffs[0].to_string());

    // Long alternating run summing to exactly zero in the middle coefficient.
    std::vector<int64_t> u(64, M), v(64);
    for (size_t i = 0; i < v.size(); ++i) v[i] = (i % 2) ? -M : M;
    compare_with_ref(u, v, "long cancellation");
    std::cout << "extreme tests done\n";
}

void test_large_ones() {
    // 100k + 100k (total 200k, the supported maximum): coefficient k of the
    // all-ones convolution is min(k+1, 2N-1-k).
    const size_t N = 100000;
    std::vector<int64_t> A(N, 1), B(N, 1);
    auto r = sigconv::convolve_exact(A, B);
    check(r.coeffs.size() == 2 * N - 1, "large: length");
    for (size_t k = 0; k < r.coeffs.size(); ++k) {
        size_t want = std::min(k + 1, 2 * N - 1 - k);
        if (r.coeffs[k].to_string() != std::to_string(want)) {
            check(false, "large: coeff " + std::to_string(k));
            return;
        }
    }
    std::cout << "large ones test done (ntt_size=" << r.report.ntt_size
              << ", primes=" << r.report.num_primes << ")\n";
}

} // namespace

int main() {
    test_primitive_roots();
    test_random();
    test_extremes();
    test_large_ones();
    if (g_failures) {
        std::cerr << g_failures << " failure(s)\n";
        return 1;
    }
    std::cout << "all unit tests passed\n";
    return 0;
}
