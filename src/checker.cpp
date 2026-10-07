#include "checker.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <set>
#include <sstream>

namespace seqcheck {

std::string validate_params(std::uint64_t modulus, std::uint64_t window) {
    if (modulus == 0)
        return "modulus must be >= 1";
    if (window == 0)
        return "window must be >= 1";
    if (window > modulus / 2)
        return "window too large: disambiguation requires 2*window <= modulus";
    return "";
}

std::vector<std::uint64_t> resolve_candidates(std::uint64_t raw,
                                              std::uint64_t expected,
                                              std::uint64_t modulus,
                                              std::uint64_t window) {
    std::vector<std::uint64_t> out;
    const std::uint64_t lo = expected > window ? expected - window : 0;
    const std::uint64_t hi = expected + window; // exclusive
    const std::uint64_t rem = raw % modulus;
    // smallest k >= lo with k % modulus == rem
    std::uint64_t k = lo + (rem + modulus - lo % modulus) % modulus;
    for (; k < hi; k += modulus)
        out.push_back(k);
    return out;
}

static const char* kind_name(ConflictKind k) {
    switch (k) {
    case ConflictKind::Parse: return "parse-error";
    case ConflictKind::Gap: return "prefix-order-violation";
    case ConflictKind::Unresolvable: return "unresolvable-seq";
    case ConflictKind::Ambiguous: return "ambiguous-seq";
    }
    return "unknown";
}

CheckResult check_packets(const std::vector<Packet>& packets,
                          std::uint64_t modulus, std::uint64_t window) {
    CheckResult result;
    std::unordered_map<std::uint64_t, std::uint64_t> expected; // stream -> next abs seq

    for (const Packet& p : packets) {
        ++result.stats.packets;
        const std::uint64_t e = expected[p.stream]; // default 0 for new streams

        const auto cands = resolve_candidates(p.seq, e, modulus, window);
        auto fail = [&](ConflictKind kind, std::string msg) {
            Conflict c;
            c.kind = kind;
            c.line_no = p.line_no;
            c.stream = p.stream;
            c.seq = p.seq;
            c.expected = e;
            c.message = std::move(msg);
            c.evidence = p.raw;
            result.conflict = std::move(c);
        };

        if (cands.empty()) {
            std::ostringstream os;
            os << kind_name(ConflictKind::Unresolvable) << ": stream " << p.stream
               << " seq " << p.seq << " has no candidate in window ["
               << (e > window ? e - window : 0) << ", " << (e + window)
               << ") mod " << modulus << " (expected abs seq " << e << ")";
            fail(ConflictKind::Unresolvable, os.str());
            break;
        }
        if (cands.size() > 1) {
            std::ostringstream os;
            os << kind_name(ConflictKind::Ambiguous) << ": stream " << p.stream
               << " seq " << p.seq << " has " << cands.size()
               << " candidates in window (modulus/window misconfigured)";
            fail(ConflictKind::Ambiguous, os.str());
            break;
        }

        const std::uint64_t k = cands.front();
        if (k < e) {
            // Retransmission of an already delivered sequence number:
            // not a new delivery, silently accepted.
            ++result.stats.retrans;
        } else if (k == e) {
            ++result.stats.delivered;
            expected[p.stream] = e + 1;
        } else {
            std::ostringstream os;
            os << kind_name(ConflictKind::Gap) << ": stream " << p.stream
               << " seq " << p.seq << " resolves to abs seq " << k
               << " but expected " << e << " (gap of " << (k - e) << ")";
            fail(ConflictKind::Gap, os.str());
            break;
        }
    }

    result.stats.streams = expected.size();
    return result;
}

namespace {

std::string trim(const std::string& s) {
    std::size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

} // namespace

ParseResult parse_log(std::istream& in) {
    ParseResult out;
    std::string line;
    std::size_t line_no = 0;
    while (std::getline(in, line)) {
        ++line_no;
        std::string text = trim(line);
        if (text.empty() || text.front() == '#')
            continue;
        if (const auto hash = text.find('#'); hash != std::string::npos)
            text = trim(text.substr(0, hash));

        std::istringstream ls(text);
        std::uint64_t stream = 0, seq = 0;
        std::string extra;
        if (!(ls >> stream >> seq) || (ls >> extra)) {
            Conflict c;
            c.kind = ConflictKind::Parse;
            c.line_no = line_no;
            c.message = "parse-error: expected '<stream> <seq>' (two unsigned integers)";
            c.evidence = line;
            out.conflict = std::move(c);
            out.packets.clear();
            return out;
        }
        out.packets.push_back(Packet{stream, seq, line_no, line});
    }
    return out;
}

CheckResult check_log(std::istream& in, std::uint64_t modulus,
                      std::uint64_t window) {
    ParseResult parsed = parse_log(in);
    if (parsed.conflict) {
        CheckResult r;
        r.conflict = std::move(parsed.conflict);
        return r;
    }
    return check_packets(parsed.packets, modulus, window);
}

bool reference_consistent(const std::vector<Packet>& packets,
                          std::uint64_t modulus, std::uint64_t window) {
    // Map arbitrary stream ids to dense indices.
    std::map<std::uint64_t, std::size_t> index_of;
    for (const Packet& p : packets)
        index_of.try_emplace(p.stream, index_of.size());

    using State = std::vector<std::uint64_t>; // next expected abs seq per stream
    std::set<State> current{State(index_of.size(), 0)};

    for (const Packet& p : packets) {
        const std::size_t idx = index_of[p.stream];
        std::set<State> next;
        for (const State& st : current) {
            const std::uint64_t e = st[idx];
            for (const std::uint64_t k : resolve_candidates(p.seq, e, modulus, window)) {
                if (k < e) {
                    next.insert(st); // retransmission: state unchanged
                } else if (k == e) {
                    State advanced = st;
                    advanced[idx] = e + 1;
                    next.insert(std::move(advanced));
                }
                // k > e: prefix-order violation, branch dies
            }
        }
        current = std::move(next);
        if (current.empty())
            return false;
    }
    return true;
}

} // namespace seqcheck
