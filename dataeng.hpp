#pragma once

#include <compare>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace dataeng {

// Administrative level of a dictionary entry. The numeric values are part of
// the public ordering used by stable keys, so keep new levels at the end.
enum class RegionLevel : std::uint8_t {
    Province = 0,
    City = 1,
    District = 2,
    Street = 3,
    Village = 4,
    Other = 5,
};

std::string_view to_string(RegionLevel level) noexcept;

// A half-open range measured in Unicode code points. These are positions in
// the decoded input, not byte offsets. Byte positions are carried separately so
// that callers can slice the original UTF-8 text.
struct TextSpan {
    std::size_t begin = 0;
    std::size_t end = 0;

    std::size_t length() const noexcept { return end - begin; }
    bool empty() const noexcept { return begin == end; }

    friend bool operator==(const TextSpan&, const TextSpan&) = default;
    friend auto operator<=>(const TextSpan&, const TextSpan&) = default;
};

// A half-open range measured in bytes of the original UTF-8 input.
struct ByteSpan {
    std::size_t begin = 0;
    std::size_t end = 0;

    std::size_t length() const noexcept { return end - begin; }
    bool empty() const noexcept { return begin == end; }

    friend bool operator==(const ByteSpan&, const ByteSpan&) = default;
    friend auto operator<=>(const ByteSpan&, const ByteSpan&) = default;
};

struct DictionaryEntry {
    // Stable identifier, typically an administrative code. It must be unique
    // within one dictionary snapshot.
    std::string id;
    std::string name;
    std::vector<std::string> aliases;
    RegionLevel level = RegionLevel::Other;
    // Identifier of the containing administrative region, if known.
    std::string parent_id;
    // An optional non-negative cost added to every edge produced by this entry.
    // This is useful for weighting less reliable dictionary rows.
    std::int64_t extra_cost = 0;
};

// An immutable-in-practice snapshot of an administrative dictionary. The
// segmenter copies the snapshot when it is constructed, so later changes do not
// affect already-created segmenters.
class AdminDictionary {
public:
    AdminDictionary() = default;
    explicit AdminDictionary(std::string version);
    AdminDictionary(std::string version, std::vector<DictionaryEntry> entries);

    AdminDictionary& set_version(std::string version);
    AdminDictionary& add(DictionaryEntry entry);
    AdminDictionary& add(std::string id, std::string name,
                         std::vector<std::string> aliases = {},
                         RegionLevel level = RegionLevel::Other,
                         std::string parent_id = {},
                         std::int64_t extra_cost = 0);

    const std::string& version() const noexcept { return version_; }
    const std::vector<DictionaryEntry>& entries() const noexcept { return entries_; }
    std::size_t size() const noexcept { return entries_.size(); }
    bool empty() const noexcept { return entries_.empty(); }

    const DictionaryEntry* find(std::string_view id) const;
    bool contains(std::string_view id) const { return find(id) != nullptr; }

private:
    std::string version_;
    std::vector<DictionaryEntry> entries_;
    std::unordered_map<std::string, std::size_t> id_index_;

    friend class AddressSegmenter;
};

enum class EdgeKind : std::uint8_t {
    DictionaryName = 0,
    DictionaryAlias = 1,
    Unknown = 2,
};

// One candidate edge in the segmentation DAG. `span` is the character interval
// and `bytes` locates the exact same text in the original UTF-8 string.
struct CandidateEdge {
    TextSpan span;
    ByteSpan bytes;
    // The original text slice, unchanged from the input.
    std::string text;
    EdgeKind kind = EdgeKind::Unknown;
    // Empty for unknown edges.
    std::string entry_id;
    // The dictionary surface that matched. For a name this equals `text`; for
    // an alias it is the alias spelling. Empty for unknown edges.
    std::string surface;
    RegionLevel level = RegionLevel::Other;
    std::int64_t cost = 0;

    bool is_unknown() const noexcept { return kind == EdgeKind::Unknown; }

    // Unambiguous, deterministic tie-break key for the edge. It contains the
    // character span, kind, and dictionary identifier.
    std::string stable_key() const;
};

// A complete segmentation. Every path starts at character 0 and ends at the
// input length; consecutive edges are adjacent.
struct CandidatePath {
    std::int64_t total_cost = 0;
    // Lexicographic key built from all edge keys.
    std::string stable_key;
    std::string dictionary_version;
    std::string source_text;
    std::size_t character_count = 0;
    std::vector<CandidateEdge> edges;

    std::vector<TextSpan> spans() const;
};

// Directed acyclic candidate graph. Nodes are character boundaries in
// [0, character_count]; edges are dictionary matches and unknown fallbacks.
// All edges point forward. Overlapping dictionary matches are all retained.
struct CandidateGraph {
    std::string source_text;
    std::string dictionary_version;
    std::size_t character_count = 0;
    // Map from a character boundary to its byte offset in source_text.
    // size() == character_count + 1.
    std::vector<std::size_t> byte_offsets;
    std::vector<CandidateEdge> edges;
    std::vector<std::vector<std::size_t>> outgoing_edges;

    std::size_t node_count() const noexcept { return character_count + 1; }

    const std::vector<std::size_t>& outgoing(std::size_t node) const noexcept;

    // Slice source_text using a character interval.
    std::string_view source_slice(const TextSpan& span) const noexcept;

    // Structural check: all edges are forward and inside the character range.
    bool is_dag() const noexcept;

    // Returns at most `n` complete paths ordered by (total_cost, stable_key).
    // Paths are computed lazily; nothing is selected as "the" address.
    std::vector<CandidatePath> top_paths(std::size_t n) const;
};

struct SegmenterOptions {
    // Cost of an exact dictionary name match.
    std::int64_t name_cost = 1;
    // Cost of an alias match. The default makes names preferable on a tie.
    std::int64_t alias_cost = 2;
    // Cost of each unmatched input character. One edge is emitted per maximal
    // uncovered fragment and, as a fallback, per unknown character.
    std::int64_t unknown_char_cost = 100;
    // Emit a single edge for each maximal fragment not covered by any
    // dictionary match, in addition to per-character unknown fallbacks.
    bool group_unknown_runs = true;
};

// Reusable, copyable segmenter. Construction validates the dictionary and
// builds a private code-point trie; build_graph() is thread-safe as long as no
// dictionary is mutated through this object (the API exposes it only as const).
class AddressSegmenter {
public:
    explicit AddressSegmenter(AdminDictionary dictionary,
                              SegmenterOptions options = {});

    const AdminDictionary& dictionary() const noexcept;
    const SegmenterOptions& options() const noexcept;

    // Throws std::invalid_argument for invalid UTF-8.
    CandidateGraph build_graph(std::string_view text) const;

    // Convenience wrapper: build_graph(text).top_paths(n).
    std::vector<CandidatePath> top_paths(std::string_view text,
                                         std::size_t n) const;

private:
    struct Impl;
    std::shared_ptr<const Impl> impl_;
};

using Segmenter = AddressSegmenter;

}  // namespace dataeng
