#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace pgc {

// A single key/value record. Records with equal keys are ordered by version.
struct Record {
    std::string key;
    std::uint64_t version = 0;
    std::string value;

    bool operator==(const Record&) const = default;
};

enum class ErrorCode {
    RecordTooLarge,   // a single record exceeds the page byte budget
    ChecksumMismatch, // page or file checksum verification failed
    CorruptData,      // malformed page/archive structure
    IoFailure,        // filesystem error while publishing/loading
};

struct Error {
    ErrorCode code;
    std::string message;
};

// Minimal expected-like result type (C++20 has no std::expected).
template <typename T>
class Expected {
public:
    static Expected ok(T value) { return Expected(std::move(value)); }
    static Expected err(Error error) { return Expected(std::move(error)); }

    bool has_value() const { return std::holds_alternative<T>(state_); }
    explicit operator bool() const { return has_value(); }
    T& value() & { return std::get<T>(state_); }
    const T& value() const& { return std::get<T>(state_); }
    T&& value() && { return std::get<T>(std::move(state_)); }
    const Error& error() const { return std::get<Error>(state_); }

private:
    explicit Expected(T value) : state_(std::move(value)) {}
    explicit Expected(Error error) : state_(std::move(error)) {}

    std::variant<T, Error> state_;
};

template <>
class Expected<void> {
public:
    static Expected ok() { return Expected(); }
    static Expected err(Error error) { return Expected(std::move(error)); }

    bool has_value() const { return !error_.has_value(); }
    explicit operator bool() const { return has_value(); }
    void value() const {}
    const Error& error() const { return *error_; }

private:
    Expected() = default;
    explicit Expected(Error error) : error_(std::move(error)) {}

    std::optional<Error> error_;
};

// One index entry per page: enables key-range lookup and integrity checks.
struct PageInfo {
    std::string first_key;    // smallest key stored in this page
    std::uint64_t offset = 0; // byte offset of the page inside `data`
    std::uint32_t size = 0;   // total page size in bytes (header + payload)
    std::uint32_t checksum = 0; // CRC32 of the page payload
    std::uint32_t record_count = 0;
};

struct Archive {
    std::string data;            // concatenated page bytes
    std::vector<PageInfo> index; // one entry per page, in key order
};

struct BuildOptions {
    // Hard byte budget per page, covering the page header and the
    // prefix-compressed payload. Page boundaries are decided against the
    // actual compressed sizes, never against uncompressed input sizes.
    std::size_t page_budget = 4096;
};

// Sorts records by (key, version), prefix-compresses keys, and packs them
// into pages bounded by the compressed byte budget. Fails with
// RecordTooLarge if any single record cannot fit in an empty page.
Expected<Archive> build(std::vector<Record> records, const BuildOptions& options = {});

// Reconstructs the original records (sorted by key, then version) and
// verifies every page checksum.
Expected<std::vector<Record>> decompress(const Archive& archive);

// Serializes an archive (index + data + file checksum) to bytes.
std::string serialize(const Archive& archive);

// Parses and verifies bytes produced by serialize().
Expected<Archive> deserialize(const std::string& bytes);

// Atomically publishes an archive: writes to a temporary sibling file and
// renames it over `path` only after the write fully succeeds. On any
// failure no file at `path` is created or modified.
Expected<void> publish(const Archive& archive, const std::string& path);

// Loads an archive previously written by publish().
Expected<Archive> load(const std::string& path);

// Convenience pipeline: build + publish. Guarantees that a failed build
// leaves `path` untouched (no partial or stale output is published).
Expected<void> build_and_publish(std::vector<Record> records,
                                 const BuildOptions& options,
                                 const std::string& path);

} // namespace pgc
