#include "scenario.hpp"

#include <fstream>
#include <sstream>
#include <stdexcept>

namespace sim {
namespace {

[[noreturn]] void fail(const std::string& source, int line_no,
                       const std::string& msg) {
    throw std::runtime_error(source + ":" + std::to_string(line_no) + ": " +
                             msg);
}

long to_long(const std::string& tok, const std::string& source, int line_no) {
    try {
        size_t pos = 0;
        long v = std::stol(tok, &pos);
        if (pos != tok.size()) throw std::invalid_argument("trailing");
        return v;
    } catch (const std::exception&) {
        fail(source, line_no, "expected an integer, got '" + tok + "'");
    }
}

struct DamageRecord {
    long target;
    long ammo;
    long rounds;
    long damage;
    int line_no;
};

}  // namespace

Scenario parse_scenario(std::istream& input, const std::string& source_name) {
    int budget = -1;
    int ammo_types = -1;
    std::vector<Target> targets;
    std::vector<DamageRecord> records;

    std::string raw;
    int line_no = 0;
    while (std::getline(input, raw)) {
        ++line_no;
        const auto hash = raw.find('#');
        if (hash != std::string::npos) raw.erase(hash);
        std::istringstream line(raw);
        std::string kw;
        if (!(line >> kw)) continue;

        if (kw == "budget") {
            std::string tok;
            if (!(line >> tok)) fail(source_name, line_no, "budget: missing value");
            if (budget >= 0) fail(source_name, line_no, "duplicate 'budget'");
            budget = static_cast<int>(to_long(tok, source_name, line_no));
            if (budget < 0 || budget > kMaxBudget)
                fail(source_name, line_no,
                     "budget must be in [0, " + std::to_string(kMaxBudget) + "]");
        } else if (kw == "ammo") {
            std::string tok;
            if (!(line >> tok)) fail(source_name, line_no, "ammo: missing value");
            if (ammo_types >= 0) fail(source_name, line_no, "duplicate 'ammo'");
            ammo_types = static_cast<int>(to_long(tok, source_name, line_no));
            if (ammo_types < 1 || ammo_types > kMaxAmmoTypes)
                fail(source_name, line_no,
                     "ammo must be in [1, " + std::to_string(kMaxAmmoTypes) + "]");
        } else if (kw == "target") {
            std::string vtok, ttok;
            if (!(line >> vtok >> ttok))
                fail(source_name, line_no, "target: expected <value> <threshold> [name]");
            Target t;
            t.value = to_long(vtok, source_name, line_no);
            t.threshold = to_long(ttok, source_name, line_no);
            if (t.value < 0) fail(source_name, line_no, "target value must be >= 0");
            if (t.threshold < 0)
                fail(source_name, line_no, "target threshold must be >= 0");
            std::getline(line, t.name);
            const auto first = t.name.find_first_not_of(" \t");
            t.name = (first == std::string::npos) ? "" : t.name.substr(first);
            if (t.name.empty()) t.name = "T" + std::to_string(targets.size());
            targets.push_back(std::move(t));
            if (static_cast<int>(targets.size()) > kMaxTargets)
                fail(source_name, line_no,
                     "at most " + std::to_string(kMaxTargets) + " targets");
        } else if (kw == "damage") {
            std::string t, a, k, d;
            if (!(line >> t >> a >> k >> d))
                fail(source_name, line_no,
                     "damage: expected <target> <ammo> <rounds> <damage>");
            records.push_back({to_long(t, source_name, line_no),
                               to_long(a, source_name, line_no),
                               to_long(k, source_name, line_no),
                               to_long(d, source_name, line_no), line_no});
        } else {
            fail(source_name, line_no, "unknown directive '" + kw + "'");
        }
    }

    if (budget < 0) fail(source_name, 0, "missing 'budget' directive");
    if (ammo_types < 0) fail(source_name, 0, "missing 'ammo' directive");
    if (targets.empty()) fail(source_name, 0, "no 'target' directives");

    Scenario sc;
    sc.budget = budget;
    sc.ammo_types = ammo_types;
    sc.targets = std::move(targets);
    const int n = static_cast<int>(sc.targets.size());
    sc.damage.assign(n, std::vector<std::vector<long>>(
                            ammo_types, std::vector<long>(budget + 1, 0)));

    std::vector<std::vector<std::vector<char>>> seen(
        n, std::vector<std::vector<char>>(ammo_types,
                                          std::vector<char>(budget + 1, 0)));
    for (const auto& r : records) {
        const auto bad = [&](const char* what) {
            fail(source_name, r.line_no, std::string("damage: ") + what +
                                             " out of range");
        };
        if (r.target < 0 || r.target >= n) bad("target index");
        if (r.ammo < 0 || r.ammo >= ammo_types) bad("ammo index");
        if (r.rounds < 0 || r.rounds > budget) bad("rounds");
        if (r.damage < 0) fail(source_name, r.line_no, "damage must be >= 0");
        auto& slot = seen[r.target][r.ammo][r.rounds];
        if (slot) fail(source_name, r.line_no, "duplicate damage entry");
        slot = true;
        sc.damage[r.target][r.ammo][r.rounds] = r.damage;
    }
    return sc;
}

Scenario load_scenario(const std::string& path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("cannot open scenario file: " + path);
    return parse_scenario(in, path);
}

}  // namespace sim
