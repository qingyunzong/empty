#include "dataeng.hpp"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace dataeng {

namespace {

struct DecodedText {
    std::u32string codepoints;
    // byte_offsets[i] is the byte offset of code point i. It has
    // codepoints.size() + 1 entries.
    std::vector<std::size_t> byte_offsets;
};

bool is_continuation(unsigned char byte) noexcept {
    return (byte & 0xC0U) == 0x80U;
}

[[noreturn]] void invalid_utf8(std::size_t offset) {
    throw std::invalid_argument("dataeng: invalid UTF-8 at byte offset " +
                                std::to_string(offset));
}

DecodedText decode_utf8(std::string_view input) {
    DecodedText decoded;
    decoded.codepoints.reserve(input.size());
    decoded.byte_offsets.reserve(input.size() + 1);
    decoded.byte_offsets.push_back(0);

    std::size_t offset = 0;
    while (offset < input.size()) {
        const auto lead = static_cast<unsigned char>(input[offset]);
        char32_t codepoint = 0;
        std::size_t width = 0;

        if (lead < 0x80U) {
            codepoint = lead;
            width = 1;
        } else if ((lead & 0xE0U) == 0xC0U) {
            codepoint = lead & 0x1FU;
            width = 2;
        } else if ((lead & 0xF0U) == 0xE0U) {
            codepoint = lead & 0x0FU;
            width = 3;
        } else if ((lead & 0xF8U) == 0xF0U) {
            codepoint = lead & 0x07U;
            width = 4;
        } else {
            invalid_utf8(offset);
        }

        if (offset + width > input.size()) {
            invalid_utf8(offset);
        }
        for (std::size_t i = 1; i < width; ++i) {
            const auto continuation =
                static_cast<unsigned char>(input[offset + i]);
            if (!is_continuation(continuation)) {
                invalid_utf8(offset + i);
            }
            codepoint = (codepoint << 6U) | (continuation & 0x3FU);
        }

        const bool overlong =
            (width == 2 && codepoint < 0x80U) ||
            (width == 3 && codepoint < 0x800U) ||
            (width == 4 && codepoint < 0x10000U);
        const bool surrogate = codepoint >= 0xD800U && codepoint <= 0xDFFFU;
        if (overlong || surrogate || codepoint > 0x10FFFFU) {
            invalid_utf8(offset);
        }

        decoded.codepoints.push_back(codepoint);
        offset += width;
        decoded.byte_offsets.push_back(offset);
    }

    return decoded;
}

void require_surface(std::string_view surface, const char* field,
                     const std::string& entry_id) {
    if (surface.empty()) {
        throw std::invalid_argument("dataeng: empty " + std::string(field) +
                                    " for dictionary entry '" + entry_id + "'");
    }
    // Decoding is also the validation step. Keeping the decoded value local is
    // intentional: matching uses the trie built by AddressSegmenter.
    (void)decode_utf8(surface);
}

std::int64_t saturating_add(std::int64_t left, std::int64_t right) noexcept {
    constexpr auto maximum = std::numeric_limits<std::int64_t>::max();
    if (right > maximum - left) {
        return maximum;
    }
    return left + right;
}

std::int64_t saturating_multiply(std::int64_t value,
                                 std::size_t count) noexcept {
    if (value == 0 || count == 0) {
        return 0;
    }
    constexpr auto maximum = std::numeric_limits<std::int64_t>::max();
    if (count > static_cast<std::size_t>(maximum / value)) {
        return maximum;
    }
    return value * static_cast<std::int64_t>(count);
}

constexpr std::size_t kNoAlias = std::numeric_limits<std::size_t>::max();

}  // namespace

std::string_view to_string(RegionLevel level) noexcept {
    switch (level) {
        case RegionLevel::Province:
            return "province";
        case RegionLevel::City:
            return "city";
        case RegionLevel::District:
            return "district";
        case RegionLevel::Street:
            return "street";
        case RegionLevel::Village:
            return "village";
        case RegionLevel::Other:
            return "other";
    }
    return "other";
}

AdminDictionary::AdminDictionary(std::string version)
    : version_(std::move(version)) {}

AdminDictionary::AdminDictionary(std::string version,
                                 std::vector<DictionaryEntry> entries)
    : version_(std::move(version)) {
    entries_.reserve(entries.size());
    for (auto& entry : entries) {
        add(std::move(entry));
    }
}

AdminDictionary& AdminDictionary::set_version(std::string version) {
    version_ = std::move(version);
    return *this;
}

AdminDictionary& AdminDictionary::add(DictionaryEntry entry) {
    if (entry.id.empty()) {
        throw std::invalid_argument(
            "dataeng: dictionary entry id must not be empty");
    }
    if (entry.extra_cost < 0) {
        throw std::invalid_argument(
            "dataeng: dictionary entry extra_cost must be non-negative");
    }
    if (id_index_.find(entry.id) != id_index_.end()) {
        throw std::invalid_argument("dataeng: duplicate dictionary entry id '" +
                                    entry.id + "'");
    }

    require_surface(entry.name, "name", entry.id);
    for (const auto& alias : entry.aliases) {
        require_surface(alias, "alias", entry.id);
    }

    // Aliases are surfaces too. Remove textual duplicates so one entry cannot
    // emit the same edge more than once.
    std::vector<std::string> aliases;
    aliases.reserve(entry.aliases.size());
    std::unordered_set<std::string> seen_surfaces;
    seen_surfaces.insert(entry.name);
    for (auto& alias : entry.aliases) {
        if (seen_surfaces.insert(alias).second) {
            aliases.push_back(std::move(alias));
        }
    }
    entry.aliases = std::move(aliases);

    const std::string id = entry.id;
    const std::size_t index = entries_.size();
    entries_.push_back(std::move(entry));
    id_index_.emplace(id, index);
    return *this;
}

AdminDictionary& AdminDictionary::add(std::string id, std::string name,
                                      std::vector<std::string> aliases,
                                      RegionLevel level, std::string parent_id,
                                      std::int64_t extra_cost) {
    DictionaryEntry entry;
    entry.id = std::move(id);
    entry.name = std::move(name);
    entry.aliases = std::move(aliases);
    entry.level = level;
    entry.parent_id = std::move(parent_id);
    entry.extra_cost = extra_cost;
    return add(std::move(entry));
}

const DictionaryEntry* AdminDictionary::find(std::string_view id) const {
    const auto found = id_index_.find(std::string(id));
    if (found == id_index_.end()) {
        return nullptr;
    }
    return &entries_[found->second];
}

std::string CandidateEdge::stable_key() const {
    std::string key;
    key.reserve(32 + entry_id.size());
    key += std::to_string(span.begin);
    key.push_back(':');
    key += std::to_string(span.end);
    key.push_back(':');
    switch (kind) {
        case EdgeKind::DictionaryName:
            key.push_back('N');
            break;
        case EdgeKind::DictionaryAlias:
            key.push_back('A');
            break;
        case EdgeKind::Unknown:
            key.push_back('U');
            break;
    }
    key.push_back(':');
    // Length-prefixing keeps identifiers containing ':' or ';' unambiguous.
    key += std::to_string(entry_id.size());
    key.push_back('#');
    key += entry_id;
    key.push_back(';');
    return key;
}

std::vector<TextSpan> CandidatePath::spans() const {
    std::vector<TextSpan> result;
    result.reserve(edges.size());
    for (const auto& edge : edges) {
        result.push_back(edge.span);
    }
    return result;
}

const std::vector<std::size_t>& CandidateGraph::outgoing(
    std::size_t node) const noexcept {
    static const std::vector<std::size_t> empty;
    if (node >= outgoing_edges.size()) {
        return empty;
    }
    return outgoing_edges[node];
}

std::string_view CandidateGraph::source_slice(const TextSpan& span) const
    noexcept {
    if (byte_offsets.size() != character_count + 1 ||
        span.begin > span.end || span.end > character_count) {
        return {};
    }
    return std::string_view(source_text).substr(
        byte_offsets[span.begin], byte_offsets[span.end] - byte_offsets[span.begin]);
}

bool CandidateGraph::is_dag() const noexcept {
    if (byte_offsets.size() != character_count + 1 ||
        outgoing_edges.size() != node_count()) {
        return false;
    }
    for (const auto& edge : edges) {
        if (edge.span.begin >= edge.span.end ||
            edge.span.end > character_count) {
            return false;
        }
    }
    return true;
}

namespace {

struct PartialPath {
    std::int64_t cost = 0;
    std::string key;
    std::vector<std::size_t> edge_indices;
};

bool partial_less(const PartialPath& left, const PartialPath& right) {
    if (left.cost != right.cost) {
        return left.cost < right.cost;
    }
    return left.key < right.key;
}

bool same_partial(const PartialPath& left, const PartialPath& right) {
    return left.cost == right.cost && left.key == right.key;
}

}  // namespace

std::vector<CandidatePath> CandidateGraph::top_paths(std::size_t n) const {
    if (n == 0 || outgoing_edges.size() != node_count()) {
        return {};
    }

    const std::size_t nodes = node_count();
    std::vector<std::vector<PartialPath>> best(nodes);
    best[nodes - 1].push_back(PartialPath{});

    // Process nodes backwards. Edges always point to a larger character
    // boundary, so every suffix is final before it is used.
    for (std::size_t node = nodes - 1; node-- > 0;) {
        std::vector<PartialPath> candidates;
        for (const std::size_t edge_index : outgoing_edges[node]) {
            if (edge_index >= edges.size()) {
                continue;
            }
            const CandidateEdge& edge = edges[edge_index];
            if (edge.span.begin != node || edge.span.end >= nodes) {
                continue;
            }
            const auto& suffixes = best[edge.span.end];
            for (const auto& suffix : suffixes) {
                PartialPath combined;
                combined.cost = saturating_add(edge.cost, suffix.cost);
                combined.key = edge.stable_key();
                combined.key += suffix.key;
                combined.edge_indices.reserve(suffix.edge_indices.size() + 1);
                combined.edge_indices.push_back(edge_index);
                combined.edge_indices.insert(combined.edge_indices.end(),
                                             suffix.edge_indices.begin(),
                                             suffix.edge_indices.end());
                candidates.push_back(std::move(combined));
            }
        }

        std::sort(candidates.begin(), candidates.end(), partial_less);
        candidates.erase(
            std::unique(candidates.begin(), candidates.end(), same_partial),
            candidates.end());
        if (candidates.size() > n) {
            candidates.resize(n);
        }
        best[node] = std::move(candidates);
    }

    std::vector<CandidatePath> paths;
    paths.reserve(best[0].size());
    for (const auto& partial : best[0]) {
        CandidatePath path;
        path.total_cost = partial.cost;
        path.stable_key = partial.key;
        path.dictionary_version = dictionary_version;
        path.source_text = source_text;
        path.character_count = character_count;
        path.edges.reserve(partial.edge_indices.size());
        for (const std::size_t edge_index : partial.edge_indices) {
            path.edges.push_back(edges[edge_index]);
        }
        paths.push_back(std::move(path));
    }
    return paths;
}

struct AddressSegmenter::Impl {
    struct SurfaceRef {
        std::size_t entry_index = 0;
        std::size_t alias_index = kNoAlias;
        EdgeKind kind = EdgeKind::DictionaryName;
    };

    struct TrieNode {
        std::unordered_map<char32_t, std::size_t> children;
        std::vector<SurfaceRef> refs;
    };

    AdminDictionary dictionary;
    SegmenterOptions options;
    std::vector<TrieNode> trie;

    Impl(AdminDictionary input_dictionary, SegmenterOptions input_options)
        : dictionary(std::move(input_dictionary)), options(input_options) {
        if (options.name_cost < 0 || options.alias_cost < 0 ||
            options.unknown_char_cost < 0) {
            throw std::invalid_argument(
                "dataeng: segmenter costs must be non-negative");
        }

        trie.emplace_back();
        const auto& entries = dictionary.entries();
        for (std::size_t entry_index = 0; entry_index < entries.size();
             ++entry_index) {
            const DictionaryEntry& entry = entries[entry_index];
            std::unordered_set<std::u32string> seen;

            const auto name = decode_utf8(entry.name);
            seen.insert(name.codepoints);
            insert_surface(name.codepoints,
                           SurfaceRef{entry_index, kNoAlias,
                                      EdgeKind::DictionaryName});

            for (std::size_t alias_index = 0;
                 alias_index < entry.aliases.size(); ++alias_index) {
                const auto alias = decode_utf8(entry.aliases[alias_index]);
                if (!seen.insert(alias.codepoints).second) {
                    continue;
                }
                insert_surface(alias.codepoints,
                               SurfaceRef{entry_index, alias_index,
                                          EdgeKind::DictionaryAlias});
            }
        }
    }

    void insert_surface(const std::u32string& surface, SurfaceRef ref) {
        std::size_t node = 0;
        for (const char32_t codepoint : surface) {
            auto found = trie[node].children.find(codepoint);
            if (found == trie[node].children.end()) {
                const std::size_t child = trie.size();
                trie.emplace_back();
                trie[node].children.emplace(codepoint, child);
                node = child;
            } else {
                node = found->second;
            }
        }
        trie[node].refs.push_back(ref);
    }

    const std::string& surface_text(const SurfaceRef& ref) const {
        const DictionaryEntry& entry = dictionary.entries()[ref.entry_index];
        if (ref.alias_index == kNoAlias) {
            return entry.name;
        }
        return entry.aliases[ref.alias_index];
    }
};

AddressSegmenter::AddressSegmenter(AdminDictionary dictionary,
                                   SegmenterOptions options)
    : impl_(std::make_shared<Impl>(std::move(dictionary), options)) {}

const AdminDictionary& AddressSegmenter::dictionary() const noexcept {
    return impl_->dictionary;
}

const SegmenterOptions& AddressSegmenter::options() const noexcept {
    return impl_->options;
}

CandidateGraph AddressSegmenter::build_graph(std::string_view text) const {
    const DecodedText decoded = decode_utf8(text);
    const auto& codepoints = decoded.codepoints;
    const auto& byte_offsets = decoded.byte_offsets;

    CandidateGraph graph;
    graph.source_text.assign(text);
    graph.dictionary_version = impl_->dictionary.version();
    graph.character_count = codepoints.size();
    graph.byte_offsets = byte_offsets;

    const auto text_slice = [&graph, &byte_offsets](std::size_t begin,
                                                    std::size_t end) {
        return graph.source_text.substr(byte_offsets[begin],
                                        byte_offsets[end] - byte_offsets[begin]);
    };

    // Enumerate every dictionary surface beginning at every character. A
    // trie terminal can have children, so longer matches are not hidden by a
    // shorter one. All terminal references become separate, overlapping edges.
    for (std::size_t begin = 0; begin < codepoints.size(); ++begin) {
        std::size_t trie_node = 0;
        for (std::size_t end = begin; end < codepoints.size(); ++end) {
            const auto found =
                impl_->trie[trie_node].children.find(codepoints[end]);
            if (found == impl_->trie[trie_node].children.end()) {
                break;
            }
            trie_node = found->second;

            for (const auto& ref : impl_->trie[trie_node].refs) {
                const DictionaryEntry& entry =
                    impl_->dictionary.entries()[ref.entry_index];
                CandidateEdge edge;
                edge.span = TextSpan{begin, end + 1};
                edge.bytes =
                    ByteSpan{byte_offsets[begin], byte_offsets[end + 1]};
                edge.text = text_slice(begin, end + 1);
                edge.kind = ref.kind;
                edge.entry_id = entry.id;
                edge.surface = impl_->surface_text(ref);
                edge.level = entry.level;
                const std::int64_t base =
                    ref.kind == EdgeKind::DictionaryName
                        ? impl_->options.name_cost
                        : impl_->options.alias_cost;
                edge.cost = saturating_add(base, entry.extra_cost);
                graph.edges.push_back(std::move(edge));
            }
        }
    }

    const std::size_t character_count = graph.character_count;

    // Every character is also available as an unknown edge. This keeps the
    // graph complete even when dictionary matches overlap in a way that cannot
    // tile the input.
    for (std::size_t index = 0; index < character_count; ++index) {
        CandidateEdge edge;
        edge.span = TextSpan{index, index + 1};
        edge.bytes = ByteSpan{byte_offsets[index], byte_offsets[index + 1]};
        edge.text = text_slice(index, index + 1);
        edge.kind = EdgeKind::Unknown;
        edge.level = RegionLevel::Other;
        edge.cost = impl_->options.unknown_char_cost;
        graph.edges.push_back(std::move(edge));
    }

    // Mark code points covered by at least one dictionary edge. Maximal
    // uncovered runs become one unknown-fragment edge with a cost proportional
    // to their length.
    if (impl_->options.group_unknown_runs && character_count != 0) {
        std::vector<std::int64_t> coverage_delta(character_count + 1, 0);
        for (const auto& edge : graph.edges) {
            if (!edge.is_unknown()) {
                ++coverage_delta[edge.span.begin];
                --coverage_delta[edge.span.end];
            }
        }

        std::int64_t active = 0;
        std::size_t run_begin = 0;
        bool in_run = false;
        for (std::size_t index = 0; index < character_count; ++index) {
            active += coverage_delta[index];
            if (active == 0) {
                if (!in_run) {
                    run_begin = index;
                    in_run = true;
                }
            } else if (in_run) {
                if (index - run_begin > 1) {
                    CandidateEdge edge;
                    edge.span = TextSpan{run_begin, index};
                    edge.bytes = ByteSpan{byte_offsets[run_begin],
                                          byte_offsets[index]};
                    edge.text = text_slice(run_begin, index);
                    edge.kind = EdgeKind::Unknown;
                    edge.level = RegionLevel::Other;
                    edge.cost = saturating_multiply(
                        impl_->options.unknown_char_cost, index - run_begin);
                    graph.edges.push_back(std::move(edge));
                }
                in_run = false;
            }
        }
        if (in_run && character_count - run_begin > 1) {
            CandidateEdge edge;
            edge.span = TextSpan{run_begin, character_count};
            edge.bytes =
                ByteSpan{byte_offsets[run_begin], byte_offsets[character_count]};
            edge.text = text_slice(run_begin, character_count);
            edge.kind = EdgeKind::Unknown;
            edge.level = RegionLevel::Other;
            edge.cost = saturating_multiply(impl_->options.unknown_char_cost,
                                            character_count - run_begin);
            graph.edges.push_back(std::move(edge));
        }
    }

    // A deterministic edge order is required for reproducible Top-N output.
    std::sort(graph.edges.begin(), graph.edges.end(),
              [](const CandidateEdge& left, const CandidateEdge& right) {
                  if (left.span.begin != right.span.begin) {
                      return left.span.begin < right.span.begin;
                  }
                  if (left.span.end != right.span.end) {
                      return left.span.end < right.span.end;
                  }
                  if (left.kind != right.kind) {
                      return left.kind < right.kind;
                  }
                  if (left.entry_id != right.entry_id) {
                      return left.entry_id < right.entry_id;
                  }
                  if (left.cost != right.cost) {
                      return left.cost < right.cost;
                  }
                  return left.surface < right.surface;
              });

    graph.outgoing_edges.assign(graph.node_count(), {});
    for (std::size_t index = 0; index < graph.edges.size(); ++index) {
        const CandidateEdge& edge = graph.edges[index];
        if (edge.span.begin < edge.span.end &&
            edge.span.end <= graph.character_count) {
            graph.outgoing_edges[edge.span.begin].push_back(index);
        }
    }

    return graph;
}

std::vector<CandidatePath> AddressSegmenter::top_paths(std::string_view text,
                                                       std::size_t n) const {
    return build_graph(text).top_paths(n);
}

}  // namespace dataeng
