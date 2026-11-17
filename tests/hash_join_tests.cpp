#include "dlks_formal.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <optional>
#include <random>
#include <span>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

struct text_row {
    std::string key;
    std::uint32_t id = 0;
};

namespace dlks_formal {

template <>
struct spill_codec<text_row> {
    void encode(const text_row& row, std::vector<std::byte>& out) const {
        const std::uint64_t size = row.key.size();
        out.resize(sizeof(size) + row.key.size() + sizeof(row.id));
        std::memcpy(out.data(), &size, sizeof(size));
        if (!row.key.empty()) {
            std::memcpy(out.data() + sizeof(size), row.key.data(),
                        row.key.size());
        }
        std::memcpy(out.data() + sizeof(size) + row.key.size(), &row.id,
                    sizeof(row.id));
    }

    [[nodiscard]] text_row decode(std::span<const std::byte> bytes) const {
        std::uint64_t size = 0;
        if (bytes.size() < sizeof(size) + sizeof(std::uint32_t)) {
            throw std::runtime_error("corrupt text_row record");
        }
        std::memcpy(&size, bytes.data(), sizeof(size));
        if (size > bytes.size() ||
            bytes.size() != sizeof(size) + size + sizeof(std::uint32_t)) {
            throw std::runtime_error("corrupt text_row record length");
        }
        text_row row;
        row.key.assign(reinterpret_cast<const char*>(bytes.data() + sizeof(size)),
                       static_cast<std::size_t>(size));
        std::memcpy(&row.id, bytes.data() + sizeof(size) + size, sizeof(row.id));
        return row;
    }
};

}  // namespace dlks_formal

namespace {

using pair_set = std::vector<std::pair<std::uint32_t, std::uint32_t>>;

struct build_row {
    std::int64_t key = 0;
    std::uint32_t id = 0;
};

struct probe_row {
    std::int64_t key = 0;
    std::uint32_t id = 0;
};

std::filesystem::path spill_root() {
    const char* tmp = std::getenv("TMPDIR");
    const std::filesystem::path base =
        (tmp != nullptr && *tmp != '\0') ? std::filesystem::path(tmp)
                                         : std::filesystem::current_path();
    const std::filesystem::path root = base / "dlks-formal-tests";
    std::filesystem::create_directories(root);
    return root;
}

dlks_formal::join_options options_with_budget(std::size_t budget) {
    dlks_formal::join_options options;
    options.memory_budget_bytes = budget;
    options.partitions = 8;
    options.partition_fanout = 8;
    options.max_repartition_depth = 8;
    options.spill_directory = spill_root();
    return options;
}

auto non_null_int_key = [](const auto& row) -> std::optional<std::int64_t> {
    return row.key;
};

template <class BuildRow, class ProbeRow, class BuildKey, class ProbeKey>
pair_set nested_loop_join(const std::vector<BuildRow>& build,
                          const std::vector<ProbeRow>& probe,
                          BuildKey build_key,
                          ProbeKey probe_key) {
    pair_set result;
    for (const BuildRow& build_entry : build) {
        const auto build_value = build_key(build_entry);
        if (!build_value.has_value()) {
            continue;
        }
        for (const ProbeRow& probe_entry : probe) {
            const auto probe_value = probe_key(probe_entry);
            if (probe_value.has_value() && *build_value == *probe_value) {
                result.emplace_back(build_entry.id, probe_entry.id);
            }
        }
    }
    return result;
}

void normalize(pair_set& pairs) {
    std::sort(pairs.begin(), pairs.end());
}

bool expect(bool condition, const char* expression, int line) {
    if (!condition) {
        std::cerr << "assertion failed at line " << line << ": " << expression
                  << '\n';
        return false;
    }
    return true;
}

#define REQUIRE(expression)                         \
    do {                                            \
        if (!expect((expression), #expression, __LINE__)) { \
            return false;                           \
        }                                           \
    } while (false)

bool test_random_multiset_with_recursive_spill() {
    std::mt19937_64 random(0x5eed1234u);
    std::uniform_int_distribution<int> key_distribution(0, 11);
    std::uniform_int_distribution<int> null_distribution(0, 99);

    std::vector<build_row> build;
    std::vector<probe_row> probe;
    for (int index = 0; index < 600; ++index) {
        build.push_back({key_distribution(random), static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 450; ++index) {
        probe.push_back({key_distribution(random), static_cast<std::uint32_t>(index)});
    }

    // A nullable key is represented by std::optional.  The public API keeps
    // NULL rows out of the build table and out of probe matching.
    auto build_key = [&](const build_row& row) -> std::optional<std::int64_t> {
        if (null_distribution(random) < 15) {
            return std::nullopt;
        }
        return row.key;
    };
    auto probe_key = [&](const probe_row& row) -> std::optional<std::int64_t> {
        if (null_distribution(random) < 15) {
            return std::nullopt;
        }
        return row.key;
    };

    // Materialize the keys once so the nested-loop oracle and the operator see
    // the same NULL pattern.
    std::vector<std::optional<std::int64_t>> build_keys;
    std::vector<std::optional<std::int64_t>> probe_keys;
    build_keys.reserve(build.size());
    probe_keys.reserve(probe.size());
    for (const build_row& row : build) {
        build_keys.push_back(build_key(row));
    }
    for (const probe_row& row : probe) {
        probe_keys.push_back(probe_key(row));
    }

    pair_set expected;
    for (std::size_t build_index = 0; build_index < build.size(); ++build_index) {
        if (!build_keys[build_index].has_value()) {
            continue;
        }
        for (std::size_t probe_index = 0; probe_index < probe.size(); ++probe_index) {
            if (probe_keys[probe_index].has_value() &&
                *build_keys[build_index] == *probe_keys[probe_index]) {
                expected.emplace_back(build[build_index].id, probe[probe_index].id);
            }
        }
    }

    // Look up keys by row id, preserving the precomputed NULL pattern.
    auto build_lookup = [&](const build_row& row) {
        return build_keys.at(row.id);
    };
    auto probe_lookup = [&](const probe_row& row) {
        return probe_keys.at(row.id);
    };

    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, build_lookup, probe_lookup,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(4096));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(stats.output_rows == expected.size());
    REQUIRE(stats.build_rows == build.size());
    REQUIRE(stats.probe_rows == probe.size());
    REQUIRE(stats.build_null_keys + stats.probe_null_keys > 0);
    REQUIRE(stats.spilled());
    REQUIRE(stats.repartition_rounds > 0);
    REQUIRE(stats.peak_memory_bytes <= 4096);
    return true;
}

bool test_duplicate_keys_and_null_semantics() {
    const std::vector<build_row> build{{1, 10}, {1, 11}, {1, 12}, {2, 13},
                                       {2, 14}, {99, 15}};
    const std::vector<probe_row> probe{{1, 20}, {1, 21}, {2, 22}, {77, 23}};
    auto build_key = [](const build_row& row) -> std::optional<std::int64_t> {
        return row.key == 99 ? std::nullopt : std::optional<std::int64_t>(row.key);
    };
    auto probe_key = [](const probe_row& row) -> std::optional<std::int64_t> {
        return row.key == 77 ? std::nullopt : std::optional<std::int64_t>(row.key);
    };

    pair_set expected = nested_loop_join(build, probe, build_key, probe_key);
    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, build_key, probe_key,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(1024 * 1024));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(actual.size() == 3 * 2 + 2 * 1);
    REQUIRE(stats.build_null_keys == 1);
    REQUIRE(stats.probe_null_keys == 1);
    REQUIRE(stats.partition_files == 0);
    REQUIRE(stats.peak_memory_bytes <= 1024 * 1024);
    return true;
}

bool test_non_optional_key() {
    const std::vector<build_row> build{{5, 60}, {6, 61}, {7, 62}};
    const std::vector<probe_row> probe{{5, 70}, {7, 71}, {9, 72}};
    auto key = [](const auto& row) { return row.key; };

    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, key,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(1024 * 1024));

    REQUIRE(actual.size() == 2);
    REQUIRE(stats.build_null_keys == 0);
    REQUIRE(stats.probe_null_keys == 0);
    REQUIRE(stats.output_rows == 2);
    return true;
}

bool test_composite_null_key() {
    struct composite_build {
        std::optional<std::int64_t> first;
        std::optional<std::int64_t> second;
        std::uint32_t id;
    };
    struct composite_probe {
        std::optional<std::int64_t> first;
        std::optional<std::int64_t> second;
        std::uint32_t id;
    };

    const std::vector<composite_build> build{
        {1, 2, 30}, {1, 2, 31}, {1, 3, 32}, {std::nullopt, 2, 33}, {1, std::nullopt, 34}};
    const std::vector<composite_probe> probe{
        {1, 2, 40}, {1, 2, 41}, {1, 3, 42}, {2, 2, 43}, {std::nullopt, std::nullopt, 44}};

    auto build_key = [](const composite_build& row) {
        if (!row.first.has_value() || !row.second.has_value()) {
            return std::optional<std::tuple<std::int64_t, std::int64_t>>{};
        }
        return std::optional<std::tuple<std::int64_t, std::int64_t>>{
            std::tuple{*row.first, *row.second}};
    };
    auto probe_key = [](const composite_probe& row) {
        if (!row.first.has_value() || !row.second.has_value()) {
            return std::optional<std::tuple<std::int64_t, std::int64_t>>{};
        }
        return std::optional<std::tuple<std::int64_t, std::int64_t>>{
            std::tuple{*row.first, *row.second}};
    };

    pair_set expected = nested_loop_join(build, probe, build_key, probe_key);
    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, build_key, probe_key,
        [&](const composite_build& build_entry,
            const composite_probe& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(1024 * 1024));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(actual.size() == 2 * 2 + 1 * 1);
    REQUIRE(stats.build_null_keys == 2);
    REQUIRE(stats.probe_null_keys == 1);
    return true;
}

bool test_extreme_duplicate_key_uses_skew_strategy() {
    std::vector<build_row> build;
    std::vector<probe_row> probe;
    for (int index = 0; index < 2500; ++index) {
        build.push_back({7, static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 80; ++index) {
        build.push_back({1000 + index, static_cast<std::uint32_t>(2500 + index)});
    }
    for (int index = 0; index < 1800; ++index) {
        probe.push_back({7, static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 60; ++index) {
        probe.push_back({1000 + index, static_cast<std::uint32_t>(1800 + index)});
    }

    std::uint64_t emitted = 0;
    std::uint64_t checksum = 0;
    const auto stats = dlks_formal::hash_join(
        build, probe, non_null_int_key,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            ++emitted;
            checksum += build_entry.id * 1315423911u + probe_entry.id;
        },
        options_with_budget(8192));

    const std::uint64_t expected = 2500ull * 1800ull + 60ull;
    REQUIRE(emitted == expected);
    REQUIRE(stats.output_rows == expected);
    REQUIRE(stats.skewed_partitions > 0);
    REQUIRE(stats.skew_chunks >= 2);
    REQUIRE(stats.peak_memory_bytes <= 8192);
    REQUIRE(checksum != 0);
    return true;
}

bool test_skew_multiset_matches_nested_loop() {
    std::vector<build_row> build;
    std::vector<probe_row> probe;
    for (int index = 0; index < 500; ++index) {
        build.push_back({7, static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 30; ++index) {
        build.push_back({1000 + index, static_cast<std::uint32_t>(500 + index)});
    }
    for (int index = 0; index < 400; ++index) {
        probe.push_back({7, static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 20; ++index) {
        probe.push_back({1000 + index, static_cast<std::uint32_t>(400 + index)});
    }

    pair_set expected = nested_loop_join(build, probe, non_null_int_key,
                                         non_null_int_key);
    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, non_null_int_key,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(4096));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(actual.size() == 500ull * 400ull + 20ull);
    REQUIRE(stats.skewed_partitions > 0);
    REQUIRE(stats.peak_memory_bytes <= 4096);
    return true;
}

bool test_unique_keys_force_recursive_repartition() {
    std::vector<build_row> build;
    std::vector<probe_row> probe;
    for (int index = 0; index < 2500; ++index) {
        build.push_back({index, static_cast<std::uint32_t>(index)});
    }
    for (int index = 700; index < 2500; ++index) {
        probe.push_back({index, static_cast<std::uint32_t>(index)});
    }

    pair_set expected = nested_loop_join(build, probe, non_null_int_key,
                                         non_null_int_key);
    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, non_null_int_key,
        [&](const build_row& build_entry, const probe_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(4096));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(actual.size() == 1800);
    REQUIRE(stats.repartition_rounds > 0);
    REQUIRE(stats.max_repartition_depth >= 1);
    REQUIRE(stats.spilled());
    REQUIRE(stats.peak_memory_bytes <= 4096);
    return true;
}

bool test_budget_sweep_matches_nested_loop() {
    std::mt19937_64 random(0xc0ffeeu);
    std::uniform_int_distribution<int> key_distribution(0, 39);
    std::uniform_int_distribution<int> null_distribution(0, 99);

    std::vector<build_row> build;
    std::vector<probe_row> probe;
    std::vector<std::optional<std::int64_t>> build_keys;
    std::vector<std::optional<std::int64_t>> probe_keys;

    for (int index = 0; index < 900; ++index) {
        build.push_back({key_distribution(random), static_cast<std::uint32_t>(index)});
        build_keys.push_back(null_distribution(random) < 10
                                 ? std::nullopt
                                 : std::optional<std::int64_t>(build.back().key));
    }
    for (int index = 0; index < 700; ++index) {
        probe.push_back({key_distribution(random), static_cast<std::uint32_t>(index)});
        probe_keys.push_back(null_distribution(random) < 10
                                 ? std::nullopt
                                 : std::optional<std::int64_t>(probe.back().key));
    }

    auto build_lookup = [&](const build_row& row) { return build_keys.at(row.id); };
    auto probe_lookup = [&](const probe_row& row) { return probe_keys.at(row.id); };

    pair_set expected;
    for (const build_row& build_entry : build) {
        const auto build_value = build_lookup(build_entry);
        if (!build_value.has_value()) {
            continue;
        }
        for (const probe_row& probe_entry : probe) {
            const auto probe_value = probe_lookup(probe_entry);
            if (probe_value.has_value() && *build_value == *probe_value) {
                expected.emplace_back(build_entry.id, probe_entry.id);
            }
        }
    }
    normalize(expected);

    for (const std::size_t budget :
         {std::size_t{1024}, std::size_t{4096}, std::size_t{8192},
          std::size_t{16384}, std::size_t{65536}}) {
        pair_set actual;
        const auto stats = dlks_formal::hash_join(
            build, probe, build_lookup, probe_lookup,
            [&](const build_row& build_entry, const probe_row& probe_entry) {
                actual.emplace_back(build_entry.id, probe_entry.id);
            },
            options_with_budget(budget));
        normalize(actual);
        REQUIRE(actual == expected);
        REQUIRE(stats.output_rows == expected.size());
        REQUIRE(stats.peak_memory_bytes <= budget);
        if (budget == 65536) {
            REQUIRE(stats.partition_files == 0);
        } else {
            REQUIRE(stats.spilled());
        }
    }
    return true;
}

bool test_custom_spill_codec() {
    std::vector<text_row> build;
    std::vector<text_row> probe;
    for (int index = 0; index < 60; ++index) {
        build.push_back({"alpha", static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 20; ++index) {
        build.push_back({"beta", static_cast<std::uint32_t>(60 + index)});
    }
    for (int index = 0; index < 5; ++index) {
        build.push_back({"", static_cast<std::uint32_t>(80 + index)});
    }
    for (int index = 0; index < 40; ++index) {
        probe.push_back({"alpha", static_cast<std::uint32_t>(index)});
    }
    for (int index = 0; index < 10; ++index) {
        probe.push_back({"beta", static_cast<std::uint32_t>(40 + index)});
    }
    for (int index = 0; index < 3; ++index) {
        probe.push_back({"", static_cast<std::uint32_t>(50 + index)});
    }

    auto key = [](const text_row& row) {
        return std::optional<std::string>(row.key);
    };
    pair_set expected = nested_loop_join(build, probe, key, key);
    pair_set actual;
    const auto stats = dlks_formal::hash_join(
        build, probe, key,
        [&](const text_row& build_entry, const text_row& probe_entry) {
            actual.emplace_back(build_entry.id, probe_entry.id);
        },
        options_with_budget(1024));

    normalize(expected);
    normalize(actual);
    REQUIRE(actual == expected);
    REQUIRE(actual.size() == 60ull * 40ull + 20ull * 10ull + 5ull * 3ull);
    REQUIRE(stats.spilled());
    REQUIRE(stats.peak_memory_bytes <= 1024);
    return true;
}

}  // namespace

int main() {
    int failures = 0;
    const auto run = [&](const char* name, bool (*test)()) {
        if (test()) {
            std::cout << "PASS " << name << '\n';
        } else {
            std::cout << "FAIL " << name << '\n';
            ++failures;
        }
    };

    run("random_multiset_with_recursive_spill",
        test_random_multiset_with_recursive_spill);
    run("duplicate_keys_and_null_semantics",
        test_duplicate_keys_and_null_semantics);
    run("non_optional_key", test_non_optional_key);
    run("composite_null_key", test_composite_null_key);
    run("extreme_duplicate_key_uses_skew_strategy",
        test_extreme_duplicate_key_uses_skew_strategy);
    run("skew_multiset_matches_nested_loop",
        test_skew_multiset_matches_nested_loop);
    run("unique_keys_force_recursive_repartition",
        test_unique_keys_force_recursive_repartition);
    run("budget_sweep_matches_nested_loop",
        test_budget_sweep_matches_nested_loop);
    run("custom_spill_codec", test_custom_spill_codec);

    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return 1;
    }
    std::cout << "all hash join tests passed\n";
    return 0;
}
