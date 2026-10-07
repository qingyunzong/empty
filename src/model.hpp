#pragma once
// Graph model and input parsing.
//
// Input format (whitespace separated, '#' starts a comment):
//   N M          number of vertices, number of edges (M <= 63)
//   S T          source and target vertex ids (0-based)
//   u v p        M lines: directed edge u -> v with rational probability p
//                p given as integer ("1"), fraction ("2/3") or decimal ("0.75");
//                must satisfy 0 <= p <= 1. Edges are mutually independent.

#include "rational.hpp"
#include <sstream>
#include <vector>

struct Edge {
    int u, v;
    Rational p;
};

struct Graph {
    int n = 0;
    int s = 0, t = 0;
    std::vector<Edge> edges;
};

inline Rational parseProbability(const std::string& tok) {
    auto slash = tok.find('/');
    if (slash != std::string::npos) {
        BigInt n = BigInt::fromString(tok.substr(0, slash));
        BigInt d = BigInt::fromString(tok.substr(slash + 1));
        if (d.neg) {
            n = -n;
            d = -d;
        }
        if (d.isZero()) throw std::runtime_error("zero denominator in probability: " + tok);
        return Rational(n, d.mag);
    }
    if (tok.find('.') != std::string::npos) {
        // finite decimal -> exact fraction
        std::string s = tok;
        bool negf = false;
        if (!s.empty() && s[0] == '-') {
            negf = true;
            s = s.substr(1);
        }
        auto dot = s.find('.');
        std::string ip = s.substr(0, dot), fp = s.substr(dot + 1);
        if (ip.empty()) ip = "0";
        for (char c : ip)
            if (!isdigit((unsigned char)c)) throw std::runtime_error("bad probability: " + tok);
        for (char c : fp)
            if (!isdigit((unsigned char)c)) throw std::runtime_error("bad probability: " + tok);
        BigUInt num = BigUInt::fromString(ip);
        BigUInt den(1);
        for (size_t i = 0; i < fp.size(); ++i) {
            num = BigUInt::mulSmall(num, 10);
            num = BigUInt::addSmall(num, static_cast<uint32_t>(fp[i] - '0'));
            den = BigUInt::mulSmall(den, 10);
        }
        return Rational(BigInt(num, negf), den);
    }
    return Rational(BigInt::fromString(tok), BigUInt(1));
}

inline Graph parseGraph(const std::string& text) {
    // strip comments
    std::string clean;
    std::istringstream lines(text);
    std::string line;
    while (std::getline(lines, line)) {
        auto hash = line.find('#');
        clean += line.substr(0, hash);
        clean += '\n';
    }
    std::istringstream in(clean);
    Graph g;
    long long n, m;
    if (!(in >> n >> m)) throw std::runtime_error("expected: N M");
    if (n < 1 || n > 1000000) throw std::runtime_error("bad vertex count");
    if (m < 0 || m > 63) throw std::runtime_error("edge count must be in [0, 63]");
    long long s, t;
    if (!(in >> s >> t)) throw std::runtime_error("expected: S T");
    if (s < 0 || s >= n || t < 0 || t >= n) throw std::runtime_error("bad source/target");
    g.n = static_cast<int>(n);
    g.s = static_cast<int>(s);
    g.t = static_cast<int>(t);
    for (long long i = 0; i < m; ++i) {
        long long u, v;
        std::string ptok;
        if (!(in >> u >> v >> ptok))
            throw std::runtime_error("expected edge line: u v p");
        if (u < 0 || u >= n || v < 0 || v >= n)
            throw std::runtime_error("edge endpoint out of range");
        Rational p = parseProbability(ptok);
        if (p.num.neg || Rational(1) < p)
            throw std::runtime_error("probability out of [0,1]: " + ptok);
        g.edges.push_back({static_cast<int>(u), static_cast<int>(v), p});
    }
    return g;
}
