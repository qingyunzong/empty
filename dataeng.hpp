#pragma once

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

/// Unicode version of the embedded NFKC and case-folding tables.
inline constexpr std::string_view kUnicodeVersion = "16.0.0";
inline constexpr std::string_view unicode_version = kUnicodeVersion;

/// Half-open byte interval [begin, end) in the original input.
struct ByteRange {
    std::size_t begin = 0;
    std::size_t end = 0;

    [[nodiscard]] constexpr std::size_t size() const noexcept { return end - begin; }
    [[nodiscard]] constexpr bool empty() const noexcept { return begin == end; }
    friend constexpr bool operator==(ByteRange, ByteRange) = default;
};

/// One normalized output code point and the input bytes it came from.
struct CodePoint {
    char32_t value = 0;
    ByteRange source{};
    friend constexpr bool operator==(const CodePoint&, const CodePoint&) = default;
};

/// What to do with Default_Ignorable_Code_Point characters.
enum class IgnorablePolicy : std::uint8_t {
    Remove,  ///< Drop the character and record it in NormalizeResult::removals.
    Keep,    ///< Keep the character unchanged.
    Reject,  ///< Keep the character for inspection, emit a diagnostic, mark invalid.
};

/// What to do with code points whose script is not in allowed_scripts.
enum class ScriptPolicy : std::uint8_t {
    AllowAll,          ///< No script restriction.
    RemoveDisallowed,  ///< Drop disallowed code points and record them.
    RejectDisallowed,  ///< Keep them for inspection, emit a diagnostic, mark invalid.
};

enum class DiagnosticKind : std::uint8_t {
    InvalidUtf8,
    DisallowedIgnorable,
    DisallowedScript,
};

enum class RemovalReason : std::uint8_t {
    DefaultIgnorable,
    DisallowedScript,
};

struct Diagnostic {
    DiagnosticKind kind{};
    ByteRange source{};
    char32_t code_point = 0;
    std::string message;
};

struct Removed {
    char32_t value = 0;
    ByteRange source{};
    RemovalReason reason{};
};

/// A maximal valid UTF-8 run, or one isolated ill-formed subsequence.
struct Segment {
    ByteRange source{};
    bool valid_utf8 = true;
    std::vector<CodePoint> code_points;
};

struct NormalizeOptions {
    /// Only the embedded version is accepted; "16", "16.0", "16.0.0" and
    /// "latest" are understood. Other versions throw std::invalid_argument.
    std::string unicode_version{std::string(kUnicodeVersion)};
    IgnorablePolicy ignorables = IgnorablePolicy::Remove;
    ScriptPolicy scripts = ScriptPolicy::AllowAll;
    /// Canonical Unicode script names (for example "Latin" or "Han").
    /// ISO 15924 aliases such as "Latn" are accepted too. An empty list means
    /// no restriction even when a non-AllowAll policy is selected.
    std::vector<std::string> allowed_scripts;
};

struct NormalizeResult {
    /// Flattened normalized output; every code point keeps its source byte span.
    std::vector<CodePoint> code_points;
    /// Input order. Invalid UTF-8 is represented by valid_utf8 == false and an
    /// empty code_points list, so it can never interact with neighbouring text.
    std::vector<Segment> segments;
    std::vector<Diagnostic> diagnostics;
    std::vector<Removed> removals;
    /// UTF-8 of code_points. For invalid input this is the normalized text of
    /// the valid runs only; use has_invalid_utf8() to detect that case.
    std::string key;

    [[nodiscard]] bool valid() const noexcept;
    [[nodiscard]] bool has_invalid_utf8() const noexcept;
    [[nodiscard]] std::vector<ByteRange> invalid_utf8_ranges() const;
};

class Normalizer {
public:
    explicit Normalizer(NormalizeOptions options = {});

    [[nodiscard]] const NormalizeOptions& options() const noexcept { return options_; }
    [[nodiscard]] NormalizeResult normalize(std::string_view input) const;

private:
    NormalizeOptions options_;
    std::vector<std::uint16_t> allowed_script_ids_;
    std::uint16_t common_script_id_ = 0;
    std::uint16_t inherited_script_id_ = 0;
    std::uint16_t unknown_script_id_ = 0;
    bool script_restriction_ = false;
};

struct Entry {
    /// Exact original bytes, preserved even when they are not valid UTF-8.
    std::string original;
    NormalizeResult normalized;
};

/// All entries that fold to the same key. No entry is silently removed.
struct ConflictGroup {
    std::string key;
    /// Indexes into BatchResult::entries, in input order.
    std::vector<std::size_t> entries;
    /// Exact distinct original byte strings, in first-occurrence order.
    std::vector<std::string> distinct_originals;

    [[nodiscard]] bool is_conflict() const noexcept { return distinct_originals.size() > 1; }
};

struct BatchResult {
    /// One item per input, in input order, including duplicates and invalid text.
    std::vector<Entry> entries;
    /// Groups for every valid entry, keyed by normalized key.
    std::vector<ConflictGroup> groups;
    /// Subset of groups with more than one distinct original text.
    std::vector<ConflictGroup> conflicts;

    [[nodiscard]] bool valid() const noexcept;
    [[nodiscard]] std::size_t size() const noexcept { return entries.size(); }
};

NormalizeResult normalize_identifier(std::string_view input, const NormalizeOptions& options = {});
NormalizeResult normalize(std::string_view input, const NormalizeOptions& options = {});

BatchResult normalize_identifiers(std::span<const std::string_view> inputs,
                                  const NormalizeOptions& options = {});
BatchResult normalize_identifiers(std::span<const std::string> inputs,
                                  const NormalizeOptions& options = {});
BatchResult normalize_identifiers(std::initializer_list<std::string_view> inputs,
                                  const NormalizeOptions& options = {});

struct Utf8Error {
    ByteRange source{};
};

/// Split a byte string into valid UTF-8 code points and isolated ill-formed
/// maximal subparts, as recommended by the Unicode Standard.
[[nodiscard]] std::vector<Utf8Error> validate_utf8(std::string_view input);

/// Encode normalized code points back to UTF-8.
[[nodiscard]] std::string to_utf8(std::span<const CodePoint> code_points);

namespace unicode {

[[nodiscard]] std::string_view version() noexcept;
[[nodiscard]] int canonical_combining_class(char32_t code_point) noexcept;
[[nodiscard]] bool is_default_ignorable(char32_t code_point) noexcept;
/// Primary Unicode Script value; "Unknown" for unassigned code points.
[[nodiscard]] std::string_view script(char32_t code_point) noexcept;
/// Script_Extensions values, falling back to the primary Script value.
[[nodiscard]] std::vector<std::string_view> script_extensions(char32_t code_point);

}  // namespace unicode

using Options = NormalizeOptions;
using UnicodeIdentifierNormalizer = Normalizer;

}  // namespace dataeng
