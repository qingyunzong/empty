#include "pgc/page_compressor.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <random>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            std::cerr << "CHECK failed at line " << __LINE__ << ": " #cond "\n";               \
            ++g_failures;                                                                      \
        }                                                                                      \
    } while (0)

std::vector<pgc::Record> sorted_copy(std::vector<pgc::Record> records) {
    std::sort(records.begin(), records.end(), [](const pgc::Record& a, const pgc::Record& b) {
        if (a.key != b.key) return a.key < b.key;
        return a.version < b.version;
    });
    return records;
}

// --------------------------------------------------------------------------
// Round trip
// --------------------------------------------------------------------------

void round_trip_basic() {
    std::vector<pgc::Record> input;
    for (int i = 0; i < 500; ++i)
        input.push_back({"key_" + std::to_string(499 - i), static_cast<std::uint64_t>(i % 7),
                         "value_" + std::to_string(i)});
    auto archive = pgc::build(input, {.page_budget = 256});
    CHECK(archive.has_value());
    CHECK(archive.value().index.size() > 1);
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value());
    CHECK(decoded.value() == sorted_copy(input));
}

void same_key_version_order() {
    std::vector<pgc::Record> input = {{"k", 5, "v5"}, {"k", 1, "v1"}, {"k", 3, "v3"},
                                      {"a", 9, "va"}, {"k", 2, "v2"}};
    auto archive = pgc::build(input, {.page_budget = 4096});
    CHECK(archive.has_value());
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value());
    std::vector<std::uint64_t> versions;
    for (const auto& r : decoded.value())
        if (r.key == "k") versions.push_back(r.version);
    CHECK((versions == std::vector<std::uint64_t>{1, 2, 3, 5}));
    CHECK(decoded.value().front().key == "a");
}

void empty_input() {
    auto archive = pgc::build({}, {.page_budget = 64});
    CHECK(archive.has_value());
    CHECK(archive.value().index.empty());
    CHECK(archive.value().data.empty());
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value() && decoded.value().empty());
}

// --------------------------------------------------------------------------
// Prefix compression
// --------------------------------------------------------------------------

void prefix_compression_saves_space() {
    std::vector<pgc::Record> input;
    std::size_t raw_size = 0;
    for (int i = 0; i < 200; ++i) {
        char suffix[8];
        std::snprintf(suffix, sizeof(suffix), "%05d", i);
        std::string key = "some/really/long/shared/prefix/" + std::string(suffix);
        input.push_back({key, 1, "payload"});
        raw_size += key.size() + sizeof(std::uint64_t) + 7;
    }
    auto archive = pgc::build(input, {.page_budget = 4096});
    CHECK(archive.has_value());
    // Prefix-compressed pages must be well below the raw record bytes.
    CHECK(archive.value().data.size() < raw_size / 2);
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value());
    CHECK(decoded.value() == sorted_copy(input));
}

// --------------------------------------------------------------------------
// Page boundaries (compressed byte budget)
// --------------------------------------------------------------------------

// Entry for a 1-byte key with empty value: varint(0) + varint(1) + 1 byte key
// + 8 byte version + varint(0) = 12 bytes. Page header is 16 bytes.
constexpr std::size_t kEntry = 12;
constexpr std::size_t kHeader = 16;

void page_boundary_exact_fit() {
    std::vector<pgc::Record> input = {{"a", 1, ""}, {"b", 1, ""}, {"c", 1, ""},
                                      {"d", 1, ""}, {"e", 1, ""}};
    // Budget fits exactly two entries per page: 16 + 12 + 12 = 40.
    auto archive = pgc::build(input, {.page_budget = kHeader + 2 * kEntry});
    CHECK(archive.has_value());
    CHECK(archive.value().index.size() == 3); // pages of 2, 2, 1
    CHECK(archive.value().index[0].record_count == 2);
    CHECK(archive.value().index[1].record_count == 2);
    CHECK(archive.value().index[2].record_count == 1);
    CHECK(archive.value().index[0].size == kHeader + 2 * kEntry);
    CHECK(archive.value().index[0].first_key == "a");
    CHECK(archive.value().index[1].first_key == "c");
    CHECK(archive.value().index[2].first_key == "e");
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value() && decoded.value() == sorted_copy(input));
}

void page_boundary_one_byte_under_budget() {
    // One byte short of two entries: only one record per page.
    auto archive = pgc::build({{"a", 1, ""}, {"b", 1, ""}},
                              {.page_budget = kHeader + 2 * kEntry - 1});
    CHECK(archive.has_value());
    CHECK(archive.value().index.size() == 2);
    CHECK(archive.value().index[0].record_count == 1);
}

void critical_page_size_for_single_record() {
    // A record whose compressed entry exactly equals budget - header fits.
    auto fits = pgc::build({{"a", 1, ""}}, {.page_budget = kHeader + kEntry});
    CHECK(fits.has_value());
    CHECK(fits.value().index.size() == 1);
    // One byte less and the same record must be rejected.
    auto too_small = pgc::build({{"a", 1, ""}}, {.page_budget = kHeader + kEntry - 1});
    CHECK(!too_small.has_value());
    CHECK(too_small.error().code == pgc::ErrorCode::RecordTooLarge);
}

void prefix_compression_extends_page_capacity() {
    // 40 keys sharing a 14-byte prefix. Each uncompressed entry is 27 bytes,
    // so a 100-byte budget would hold only 3 per page (14 pages). With prefix
    // compression, successor entries are ~12 bytes, so 5 fit per page.
    std::vector<pgc::Record> input;
    for (int i = 0; i < 40; ++i) {
        char suffix[4];
        std::snprintf(suffix, sizeof(suffix), "%02d", i);
        input.push_back({"sharedprefix00" + std::string(suffix), 1, ""});
    }
    auto archive = pgc::build(input, {.page_budget = 100});
    CHECK(archive.has_value());
    CHECK(archive.value().index.size() <= 8); // uncompressed would need 14
    auto decoded = pgc::decompress(archive.value());
    CHECK(decoded.has_value() && decoded.value() == sorted_copy(input));
}

// --------------------------------------------------------------------------
// Oversized record rejection
// --------------------------------------------------------------------------

void oversized_record_rejected() {
    std::string big_value(5000, 'x');
    auto result = pgc::build({{"small", 1, ""}, {"big", 1, big_value}},
                             {.page_budget = 1024});
    CHECK(!result.has_value());
    CHECK(result.error().code == pgc::ErrorCode::RecordTooLarge);
    CHECK(result.error().message.find("big") != std::string::npos);
}

void oversized_key_rejected() {
    std::string big_key(3000, 'k');
    auto result = pgc::build({{big_key, 1, ""}}, {.page_budget = 1024});
    CHECK(!result.has_value());
    CHECK(result.error().code == pgc::ErrorCode::RecordTooLarge);
}

// --------------------------------------------------------------------------
// Integrity
// --------------------------------------------------------------------------

void checksum_detects_corruption() {
    auto archive = pgc::build({{"alpha", 1, "one"}, {"beta", 2, "two"}},
                              {.page_budget = 4096});
    CHECK(archive.has_value());
    // Flip a payload byte inside the first page (after the 16-byte header).
    archive.value().data[archive.value().index[0].offset + kHeader + 2] ^= 0xFF;
    auto decoded = pgc::decompress(archive.value());
    CHECK(!decoded.has_value());
    CHECK(decoded.error().code == pgc::ErrorCode::ChecksumMismatch);
}

void corrupt_structure_detected() {
    auto archive = pgc::build({{"a", 1, ""}}, {.page_budget = 4096});
    CHECK(archive.has_value());
    archive.value().data[0] = 0; // break page magic
    auto decoded = pgc::decompress(archive.value());
    CHECK(!decoded.has_value());
    CHECK(decoded.error().code == pgc::ErrorCode::CorruptData);
}

void file_checksum_detects_corruption() {
    auto archive = pgc::build({{"a", 1, "v"}}, {.page_budget = 4096});
    CHECK(archive.has_value());
    std::string bytes = pgc::serialize(archive.value());
    bytes[bytes.size() / 2] ^= 0x01;
    auto loaded = pgc::deserialize(bytes);
    CHECK(!loaded.has_value());
    CHECK(loaded.error().code == pgc::ErrorCode::ChecksumMismatch);
}

// --------------------------------------------------------------------------
// Publish / load
// --------------------------------------------------------------------------

std::filesystem::path temp_path(const std::string& name) {
    auto dir = std::filesystem::temp_directory_path() / "pgc_tests";
    std::filesystem::create_directories(dir);
    return dir / name;
}

void publish_load_roundtrip() {
    const auto path = temp_path("roundtrip.pgc");
    std::filesystem::remove(path);
    std::vector<pgc::Record> input;
    for (int i = 0; i < 100; ++i)
        input.push_back({"user/" + std::to_string(i), static_cast<std::uint64_t>(i),
                         "blob-" + std::to_string(i)});
    auto published = pgc::build_and_publish(input, {.page_budget = 512}, path.string());
    CHECK(published.has_value());
    CHECK(std::filesystem::exists(path));
    auto loaded = pgc::load(path.string());
    CHECK(loaded.has_value());
    auto decoded = pgc::decompress(loaded.value());
    CHECK(decoded.has_value());
    CHECK(decoded.value() == sorted_copy(input));
    std::filesystem::remove(path);
}

void failed_publish_leaves_no_file() {
    const auto path = temp_path("should_not_exist.pgc");
    std::filesystem::remove(path);
    std::filesystem::remove(path.string() + ".tmp");

    std::string huge(100000, 'z');
    auto result = pgc::build_and_publish({{"ok", 1, ""}, {"huge", 1, huge}},
                                         {.page_budget = 4096}, path.string());
    CHECK(!result.has_value());
    CHECK(result.error().code == pgc::ErrorCode::RecordTooLarge);
    // Failure publication check: neither the target nor a temp file remains.
    CHECK(!std::filesystem::exists(path));
    CHECK(!std::filesystem::exists(path.string() + ".tmp"));
}

void failed_publish_preserves_existing_file() {
    const auto path = temp_path("existing.pgc");
    {
        std::ofstream out(path);
        out << "ORIGINAL-CONTENT";
    }
    std::string huge(100000, 'z');
    auto result = pgc::build_and_publish({{"huge", 1, huge}}, {.page_budget = 4096},
                                         path.string());
    CHECK(!result.has_value());
    std::ifstream in(path);
    std::string content((std::istreambuf_iterator<char>(in)),
                        std::istreambuf_iterator<char>());
    CHECK(content == "ORIGINAL-CONTENT");
    std::filesystem::remove(path);
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

const std::map<std::string, std::function<void()>>& registry() {
    static const std::map<std::string, std::function<void()>> tests = {
        {"round_trip_basic", round_trip_basic},
        {"same_key_version_order", same_key_version_order},
        {"empty_input", empty_input},
        {"prefix_compression_saves_space", prefix_compression_saves_space},
        {"page_boundary_exact_fit", page_boundary_exact_fit},
        {"page_boundary_one_byte_under_budget", page_boundary_one_byte_under_budget},
        {"critical_page_size_for_single_record", critical_page_size_for_single_record},
        {"prefix_compression_extends_page_capacity", prefix_compression_extends_page_capacity},
        {"oversized_record_rejected", oversized_record_rejected},
        {"oversized_key_rejected", oversized_key_rejected},
        {"checksum_detects_corruption", checksum_detects_corruption},
        {"corrupt_structure_detected", corrupt_structure_detected},
        {"file_checksum_detects_corruption", file_checksum_detects_corruption},
        {"publish_load_roundtrip", publish_load_roundtrip},
        {"failed_publish_leaves_no_file", failed_publish_leaves_no_file},
        {"failed_publish_preserves_existing_file", failed_publish_preserves_existing_file},
    };
    return tests;
}

} // namespace

int main(int argc, char** argv) {
    if (argc == 2) {
        const auto it = registry().find(argv[1]);
        if (it == registry().end()) {
            std::cerr << "unknown test: " << argv[1] << "\n";
            return 2;
        }
        it->second();
        return g_failures == 0 ? 0 : 1;
    }
    for (const auto& [name, fn] : registry()) {
        fn();
        if (g_failures != 0) {
            std::cerr << "FAILED: " << name << "\n";
            return 1;
        }
    }
    std::cout << "all " << registry().size() << " tests passed\n";
    return 0;
}
