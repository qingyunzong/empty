#include "statlib/stats_tree.hpp"

#include <stdexcept>

namespace statlib {

StatsTree::StatsTree(std::vector<BigInt> values) : n_(values.size()) {
    if (n_ == 0) throw std::invalid_argument("StatsTree: empty array");
    root_ = build(values, 0, n_);
}

std::shared_ptr<const StatsTree::Node> StatsTree::build(const std::vector<BigInt>& values,
                                                        std::size_t l, std::size_t r) {
    auto node = std::make_shared<Node>();
    if (r - l == 1) {
        node->sum = values[l];
        node->sumsq = values[l] * values[l];
        return node;
    }
    std::size_t mid = l + (r - l) / 2;
    node->left = build(values, l, mid);
    node->right = build(values, mid, r);
    node->sum = node->left->sum + node->right->sum;
    node->sumsq = node->left->sumsq + node->right->sumsq;
    return node;
}

std::shared_ptr<const StatsTree::Node> StatsTree::apply(
    const std::shared_ptr<const Node>& node, const BigInt& v, std::size_t len) {
    // For each element x -> x + v:
    //   sum'   = sum + v*len
    //   sumsq' = sumsq + 2*v*sum + v^2*len
    auto out = std::make_shared<Node>(*node);
    BigInt vlen = v * BigInt(static_cast<unsigned long long>(len));
    out->sumsq = node->sumsq + BigInt(2) * v * node->sum + v * vlen;
    out->sum = node->sum + vlen;
    out->lazy = node->lazy + v;
    return out;
}

std::shared_ptr<const StatsTree::Node> StatsTree::update(
    const std::shared_ptr<const Node>& node, std::size_t l, std::size_t r,
    std::size_t ql, std::size_t qr, const BigInt& v) {
    if (qr <= l || r <= ql) return node;
    if (ql <= l && r <= qr) return apply(node, v, r - l);
    std::size_t mid = l + (r - l) / 2;
    auto left = node->left;
    auto right = node->right;
    if (!node->lazy.is_zero()) {
        left = apply(left, node->lazy, mid - l);
        right = apply(right, node->lazy, r - mid);
    }
    left = update(left, l, mid, ql, qr, v);
    right = update(right, mid, r, ql, qr, v);
    auto out = std::make_shared<Node>();
    out->sum = left->sum + right->sum;
    out->sumsq = left->sumsq + right->sumsq;
    out->left = std::move(left);
    out->right = std::move(right);
    return out;
}

std::pair<BigInt, BigInt> StatsTree::query(const std::shared_ptr<const Node>& node,
                                           std::size_t l, std::size_t r,
                                           std::size_t ql, std::size_t qr,
                                           const BigInt& carry) {
    if (qr <= l || r <= ql) return {BigInt(0), BigInt(0)};
    // node->sum/sumsq already reflect node->lazy; `carry` holds only the
    // pending adds of strict ancestors that have not been applied here yet.
    if (ql <= l && r <= qr) {
        BigInt clen = carry * BigInt(static_cast<unsigned long long>(r - l));
        BigInt s = node->sum + clen;
        BigInt ss = node->sumsq + BigInt(2) * carry * node->sum + carry * clen;
        return {std::move(s), std::move(ss)};
    }
    BigInt c = carry + node->lazy;
    std::size_t mid = l + (r - l) / 2;
    auto [ls, lss] = query(node->left, l, mid, ql, qr, c);
    auto [rs, rss] = query(node->right, mid, r, ql, qr, c);
    return {ls + rs, lss + rss};
}

void StatsTree::add(std::size_t l, std::size_t r, const BigInt& v) {
    if (l > r || r > n_) throw std::out_of_range("StatsTree::add range");
    if (l == r || v.is_zero()) return;
    root_ = update(root_, 0, n_, l, r, v);
}

BigInt StatsTree::sum(std::size_t l, std::size_t r) const {
    if (l > r || r > n_) throw std::out_of_range("StatsTree::sum range");
    if (l == r) return BigInt(0);
    return query(root_, 0, n_, l, r, BigInt(0)).first;
}

BigInt StatsTree::sumsq(std::size_t l, std::size_t r) const {
    if (l > r || r > n_) throw std::out_of_range("StatsTree::sumsq range");
    if (l == r) return BigInt(0);
    return query(root_, 0, n_, l, r, BigInt(0)).second;
}

Rational StatsTree::mean(std::size_t l, std::size_t r) const {
    if (l >= r || r > n_) throw std::out_of_range("StatsTree::mean range");
    return Rational(sum(l, r), BigInt(static_cast<unsigned long long>(r - l)));
}

Rational StatsTree::variance(std::size_t l, std::size_t r) const {
    if (l >= r || r > n_) throw std::out_of_range("StatsTree::variance range");
    BigInt n(static_cast<unsigned long long>(r - l));
    Rational ex2(sumsq(l, r), n);
    Rational ex(sum(l, r), n);
    return ex2 - ex * ex;
}

}  // namespace statlib
