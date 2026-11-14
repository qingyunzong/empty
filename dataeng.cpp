#include "dataeng.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <map>
#include <stdexcept>
#include <utility>

namespace dataeng::tables {

struct CccRange {
    std::uint32_t first;
    std::uint32_t last;
    std::uint8_t ccc;
};

struct MappingEntry {
    std::uint32_t code_point;
    std::uint32_t offset;
    std::uint16_t length;
};

struct ComposeEntry {
    std::uint32_t first;
    std::uint32_t second;
    std::uint32_t composite;
};

struct Range {
    std::uint32_t first;
    std::uint32_t last;
};

struct ScriptRange {
    std::uint32_t first;
    std::uint32_t last;
    std::uint16_t script;
};

struct ScxEntry {
    std::uint32_t code_point;
    std::uint32_t offset;
    std::uint16_t count;
};

}  // namespace dataeng::tables

#include "unicode_tables.inc"

namespace dataeng {
namespace {

static_assert(std::string_view(tables::kUnicodeVersionString) == kUnicodeVersion);

constexpr char32_t kMaxCodePoint = 0x10FFFF;

bool is_scalar(char32_t cp) noexcept {
    return cp <= kMaxCodePoint && !(cp >= 0xD800 && cp <= 0xDFFF);
}

template <typename T, std::size_t N, typename First, typename Last>
const T* find_range(const T (&ranges)[N], char32_t cp, First first, Last last) noexcept {
    std::size_t low = 0;
    std::size_t high = N;
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2;
        if (cp < first(ranges[middle])) {
            high = middle;
        } else if (cp > last(ranges[middle])) {
            low = middle + 1;
        } else {
            return &ranges[middle];
        }
    }
    return nullptr;
}

template <std::size_t N>
const tables::MappingEntry* find_mapping(char32_t cp,
                                         const tables::MappingEntry (&entries)[N]) noexcept {
    std::size_t low = 0;
    std::size_t high = N;
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2;
        if (cp < entries[middle].code_point) {
            high = middle;
        } else if (cp > entries[middle].code_point) {
            low = middle + 1;
        } else {
            return &entries[middle];
        }
    }
    return nullptr;
}

std::uint8_t combining_class(char32_t cp) noexcept {
    const auto* range = find_range(
        tables::kCccRanges, cp, [](const auto& r) { return r.first; },
        [](const auto& r) { return r.last; });
    return range == nullptr ? 0 : range->ccc;
}

bool default_ignorable(char32_t cp) noexcept {
    return find_range(
               tables::kIgnorableRanges, cp, [](const auto& r) { return r.first; },
               [](const auto& r) { return r.last; }) != nullptr;
}

std::uint16_t script_id(char32_t cp) noexcept {
    if (!is_scalar(cp)) {
        return static_cast<std::uint16_t>(tables::kScriptNamesCount - 1);
    }
    const auto* range = find_range(
        tables::kScriptRanges, cp, [](const auto& r) { return r.first; },
        [](const auto& r) { return r.last; });
    return range == nullptr ? static_cast<std::uint16_t>(tables::kScriptNamesCount - 1)
                            : range->script;
}

const tables::ScxEntry* find_script_extensions(char32_t cp) noexcept {
    std::size_t low = 0;
    std::size_t high = tables::kScxEntriesCount;
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2;
        if (cp < tables::kScxEntries[middle].code_point) {
            high = middle;
        } else if (cp > tables::kScxEntries[middle].code_point) {
            low = middle + 1;
        } else {
            return &tables::kScxEntries[middle];
        }
    }
    return nullptr;
}

char32_t compose_pair(char32_t first, char32_t second) noexcept {
    // Hangul syllable composition, UAX #15 section 3.12.
    if (first >= 0x1100 && first <= 0x1112 && second >= 0x1161 && second <= 0x1175) {
        const char32_t l_index = first - 0x1100;
        const char32_t v_index = second - 0x1161;
        return 0xAC00 + (l_index * 21 + v_index) * 28;
    }
    if (first >= 0xAC00 && first <= 0xD7A3 && (first - 0xAC00) % 28 == 0 &&
        second >= 0x11A8 && second <= 0x11C2) {
        return first + (second - 0x11A7);
    }

    const std::uint64_t key =
        (static_cast<std::uint64_t>(first) << 21) | static_cast<std::uint64_t>(second);
    std::size_t low = 0;
    std::size_t high = tables::kComposeEntriesCount;
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2;
        const auto& entry = tables::kComposeEntries[middle];
        const std::uint64_t entry_key =
            (static_cast<std::uint64_t>(entry.first) << 21) | entry.second;
        if (key < entry_key) {
            high = middle;
        } else if (key > entry_key) {
            low = middle + 1;
        } else {
            return static_cast<char32_t>(entry.composite);
        }
    }
    return 0;
}

std::string script_key(std::string_view name) {
    std::string key;
    key.reserve(name.size());
    for (const unsigned char ch : name) {
        if (std::isalnum(ch) != 0) {
            key.push_back(static_cast<char>(std::tolower(ch)));
        }
    }
    return key;
}

std::string_view canonical_script_alias(std::string_view key) noexcept {
    static constexpr std::pair<std::string_view, std::string_view> aliases[] = {
        {"latn", "latin"},          {"grek", "greek"},       {"cyrl", "cyrillic"},
        {"arab", "arabic"},         {"hebr", "hebrew"},      {"deva", "devanagari"},
        {"hani", "han"},            {"hang", "hangul"},      {"hira", "hiragana"},
        {"kana", "katakana"},       {"thai", "thai"},        {"armn", "armenian"},
        {"geor", "georgian"},       {"beng", "bengali"},     {"guru", "gurmukhi"},
        {"gujr", "gujarati"},       {"orya", "oriya"},       {"taml", "tamil"},
        {"telu", "telugu"},         {"knda", "kannada"},     {"mlym", "malayalam"},
        {"sinh", "sinhala"},        {"mymr", "myanmar"},     {"khmr", "khmer"},
        {"laoo", "lao"},            {"tibt", "tibetan"},     {"ethi", "ethiopic"},
        {"cher", "cherokee"},       {"cans", "canadianaboriginal"},
        {"yiii", "yi"},             {"mong", "mongolian"},   {"zyyy", "common"},
        {"zinh", "inherited"},      {"zzzz", "unknown"},
    };
    for (const auto& alias : aliases) {
        if (alias.first == key) {
            return alias.second;
        }
    }
    return key;
}

std::uint16_t resolve_script_id(std::string_view name) {
    const std::string key = script_key(name);
    const std::string_view canonical = canonical_script_alias(key);
    for (std::size_t i = 0; i < tables::kScriptNamesCount; ++i) {
        if (script_key(tables::kScriptNames[i]) == canonical) {
            return static_cast<std::uint16_t>(i);
        }
    }
    throw std::invalid_argument("unknown Unicode script name: " + std::string(name));
}

void validate_version(std::string_view version) {
    std::string value = script_key(version);
    if (value == "latest" || value == "unicodelatest" || value == "16" || value == "160" ||
        value == "1600" ||
        value == "unicode16" || value == "unicode160" || value == "unicode1600") {
        return;
    }
    throw std::invalid_argument("unsupported Unicode version: " + std::string(version) +
                                " (embedded version is " + std::string(kUnicodeVersion) + ")");
}

struct Decoded {
    bool valid = false;
    char32_t code_point = 0;
    std::size_t length = 1;
};

Decoded decode_one(const unsigned char* bytes, std::size_t available) noexcept {
    const unsigned char lead = bytes[0];
    if (lead <= 0x7F) {
        return {true, static_cast<char32_t>(lead), 1};
    }

    std::size_t continuation_count = 0;
    unsigned char second_min = 0x80;
    unsigned char second_max = 0xBF;
    if (lead >= 0xC2 && lead <= 0xDF) {
        continuation_count = 1;
    } else if (lead == 0xE0) {
        continuation_count = 2;
        second_min = 0xA0;
    } else if ((lead >= 0xE1 && lead <= 0xEC) || (lead >= 0xEE && lead <= 0xEF)) {
        continuation_count = 2;
    } else if (lead == 0xED) {
        continuation_count = 2;
        second_max = 0x9F;
    } else if (lead == 0xF0) {
        continuation_count = 3;
        second_min = 0x90;
    } else if (lead >= 0xF1 && lead <= 0xF3) {
        continuation_count = 3;
    } else if (lead == 0xF4) {
        continuation_count = 3;
        second_max = 0x8F;
    } else {
        // Continuation bytes, overlong leads, and values above U+10FFFF can
        // never start a well-formed sequence and form a one-byte subpart.
        return {false, 0, 1};
    }

    std::size_t consumed = 1;
    for (std::size_t i = 1; i <= continuation_count; ++i) {
        if (i >= available) {
            return {false, 0, consumed};
        }
        const unsigned char byte = bytes[i];
        const unsigned char minimum = i == 1 ? second_min : 0x80;
        const unsigned char maximum = i == 1 ? second_max : 0xBF;
        if (byte < minimum || byte > maximum) {
            return {false, 0, consumed};
        }
        ++consumed;
    }

    char32_t code_point = 0;
    switch (continuation_count) {
        case 1:
            code_point = static_cast<char32_t>(lead & 0x1F);
            break;
        case 2:
            code_point = static_cast<char32_t>(lead & 0x0F);
            break;
        case 3:
            code_point = static_cast<char32_t>(lead & 0x07);
            break;
        default:
            break;
    }
    for (std::size_t i = 1; i <= continuation_count; ++i) {
        code_point = (code_point << 6) | static_cast<char32_t>(bytes[i] & 0x3F);
    }
    return {true, code_point, continuation_count + 1};
}

void append_utf8(std::string& output, char32_t cp) {
    if (cp <= 0x7F) {
        output.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        output.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        output.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        output.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        output.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        output.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        output.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        output.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        output.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        output.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

struct SourceCodePoint {
    char32_t value = 0;
    ByteRange source{};
};

void decompose_code_point(char32_t cp, ByteRange source, std::vector<SourceCodePoint>& output,
                          int depth = 0) {
    const auto* mapping = find_mapping(cp, tables::kDecompEntries);
    if (mapping == nullptr || depth >= 32) {
        output.push_back({cp, source});
        return;
    }
    for (std::uint32_t i = 0; i < mapping->length; ++i) {
        const char32_t part =
            static_cast<char32_t>(tables::kDecompData[mapping->offset + i]);
        decompose_code_point(part, source, output, depth + 1);
    }
}

std::vector<SourceCodePoint> canonical_order(std::vector<SourceCodePoint> input) {
    for (std::size_t i = 1; i < input.size(); ++i) {
        const std::uint8_t current_class = combining_class(input[i].value);
        if (current_class == 0) {
            continue;
        }
        std::size_t j = i;
        while (j > 0) {
            const std::uint8_t previous_class = combining_class(input[j - 1].value);
            if (previous_class == 0 || previous_class <= current_class) {
                break;
            }
            std::swap(input[j - 1], input[j]);
            --j;
        }
    }
    return input;
}

std::vector<SourceCodePoint> canonical_compose(std::vector<SourceCodePoint> input) {
    std::vector<SourceCodePoint> output;
    output.reserve(input.size());
    std::size_t starter = std::string::npos;
    std::uint8_t last_class = 0;

    for (const SourceCodePoint& cp : input) {
        const std::uint8_t current_class = combining_class(cp.value);
        if (starter != std::string::npos) {
            const bool blocked = last_class != 0 && last_class >= current_class;
            if (!blocked) {
                const char32_t composite = compose_pair(output[starter].value, cp.value);
                if (composite != 0) {
                    output[starter].value = composite;
                    output[starter].source.begin =
                        std::min(output[starter].source.begin, cp.source.begin);
                    output[starter].source.end =
                        std::max(output[starter].source.end, cp.source.end);
                    continue;
                }
            }
        }

        if (current_class == 0) {
            starter = output.size();
        }
        output.push_back(cp);
        last_class = current_class;
    }
    return output;
}

std::vector<SourceCodePoint> casefold(std::vector<SourceCodePoint> input) {
    std::vector<SourceCodePoint> output;
    output.reserve(input.size());
    for (const SourceCodePoint& cp : input) {
        const auto* mapping = find_mapping(cp.value, tables::kCasefoldEntries);
        if (mapping == nullptr) {
            output.push_back(cp);
            continue;
        }
        for (std::uint32_t i = 0; i < mapping->length; ++i) {
            output.push_back(
                {static_cast<char32_t>(tables::kCasefoldData[mapping->offset + i]), cp.source});
        }
    }
    return output;
}

std::string diagnostic_message(DiagnosticKind kind) {
    switch (kind) {
        case DiagnosticKind::InvalidUtf8:
            return "ill-formed UTF-8 subsequence";
        case DiagnosticKind::DisallowedIgnorable:
            return "default-ignorable code point rejected by policy";
        case DiagnosticKind::DisallowedScript:
            return "code point script is not allowed";
    }
    return "unicode normalization diagnostic";
}

}  // namespace

bool NormalizeResult::valid() const noexcept {
    return diagnostics.empty();
}

bool NormalizeResult::has_invalid_utf8() const noexcept {
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const Diagnostic& diagnostic) {
        return diagnostic.kind == DiagnosticKind::InvalidUtf8;
    });
}

std::vector<ByteRange> NormalizeResult::invalid_utf8_ranges() const {
    std::vector<ByteRange> ranges;
    for (const Diagnostic& diagnostic : diagnostics) {
        if (diagnostic.kind == DiagnosticKind::InvalidUtf8) {
            ranges.push_back(diagnostic.source);
        }
    }
    return ranges;
}

Normalizer::Normalizer(NormalizeOptions options) : options_(std::move(options)) {
    validate_version(options_.unicode_version);
    common_script_id_ = resolve_script_id("Common");
    inherited_script_id_ = resolve_script_id("Inherited");
    unknown_script_id_ = resolve_script_id("Unknown");

    script_restriction_ =
        options_.scripts != ScriptPolicy::AllowAll && !options_.allowed_scripts.empty();
    if (script_restriction_) {
        for (const std::string& name : options_.allowed_scripts) {
            const std::uint16_t id = resolve_script_id(name);
            if (std::find(allowed_script_ids_.begin(), allowed_script_ids_.end(), id) ==
                allowed_script_ids_.end()) {
                allowed_script_ids_.push_back(id);
            }
        }
    }
}

NormalizeResult Normalizer::normalize(std::string_view input) const {
    NormalizeResult result;
    const auto* bytes = reinterpret_cast<const unsigned char*>(input.data());

    struct RawSegment {
        bool valid = true;
        ByteRange source{};
        std::vector<SourceCodePoint> code_points;
    };

    std::vector<RawSegment> raw_segments;
    std::size_t offset = 0;
    while (offset < input.size()) {
        const Decoded decoded = decode_one(bytes + offset, input.size() - offset);
        if (!decoded.valid) {
            RawSegment segment;
            segment.valid = false;
            segment.source = {offset, offset + decoded.length};
            raw_segments.push_back(std::move(segment));
            offset += decoded.length;
            continue;
        }

        RawSegment segment;
        segment.valid = true;
        segment.source.begin = offset;
        while (offset < input.size()) {
            const Decoded next = decode_one(bytes + offset, input.size() - offset);
            if (!next.valid) {
                break;
            }
            segment.code_points.push_back({next.code_point, {offset, offset + next.length}});
            offset += next.length;
        }
        segment.source.end = offset;
        raw_segments.push_back(std::move(segment));
    }

    for (const RawSegment& raw : raw_segments) {
        Segment segment;
        segment.source = raw.source;
        segment.valid_utf8 = raw.valid;

        if (!raw.valid) {
            Diagnostic diagnostic;
            diagnostic.kind = DiagnosticKind::InvalidUtf8;
            diagnostic.source = raw.source;
            diagnostic.message = diagnostic_message(diagnostic.kind);
            result.diagnostics.push_back(std::move(diagnostic));
            result.segments.push_back(std::move(segment));
            continue;
        }

        std::vector<SourceCodePoint> decomposed;
        decomposed.reserve(raw.code_points.size());
        for (const SourceCodePoint& cp : raw.code_points) {
            decompose_code_point(cp.value, cp.source, decomposed);
        }

        std::vector<SourceCodePoint> normalized = canonical_compose(canonical_order(std::move(decomposed)));
        normalized = casefold(std::move(normalized));

        segment.code_points.reserve(normalized.size());
        for (const SourceCodePoint& cp : normalized) {
            if (default_ignorable(cp.value)) {
                if (options_.ignorables == IgnorablePolicy::Remove) {
                    result.removals.push_back(
                        {cp.value, cp.source, RemovalReason::DefaultIgnorable});
                    continue;
                }
                if (options_.ignorables == IgnorablePolicy::Reject) {
                    Diagnostic diagnostic;
                    diagnostic.kind = DiagnosticKind::DisallowedIgnorable;
                    diagnostic.source = cp.source;
                    diagnostic.code_point = cp.value;
                    diagnostic.message = diagnostic_message(diagnostic.kind);
                    result.diagnostics.push_back(std::move(diagnostic));
                }
            }

            if (script_restriction_) {
                bool allowed = false;
                const auto* extensions = find_script_extensions(cp.value);
                if (extensions != nullptr) {
                    for (std::uint32_t i = 0; i < extensions->count; ++i) {
                        const std::uint16_t id = tables::kScxData[extensions->offset + i];
                        if (id == common_script_id_ || id == inherited_script_id_ ||
                            std::find(allowed_script_ids_.begin(), allowed_script_ids_.end(),
                                      id) != allowed_script_ids_.end()) {
                            allowed = true;
                            break;
                        }
                    }
                } else {
                    const std::uint16_t id = script_id(cp.value);
                    allowed = id == common_script_id_ || id == inherited_script_id_ ||
                              std::find(allowed_script_ids_.begin(), allowed_script_ids_.end(),
                                        id) != allowed_script_ids_.end();
                }

                if (!allowed) {
                    if (options_.scripts == ScriptPolicy::RemoveDisallowed) {
                        result.removals.push_back(
                            {cp.value, cp.source, RemovalReason::DisallowedScript});
                        continue;
                    }
                    Diagnostic diagnostic;
                    diagnostic.kind = DiagnosticKind::DisallowedScript;
                    diagnostic.source = cp.source;
                    diagnostic.code_point = cp.value;
                    diagnostic.message = diagnostic_message(diagnostic.kind);
                    result.diagnostics.push_back(std::move(diagnostic));
                }
            }

            segment.code_points.push_back({cp.value, cp.source});
            result.code_points.push_back({cp.value, cp.source});
        }

        result.segments.push_back(std::move(segment));
    }

    result.key = to_utf8(result.code_points);
    return result;
}

bool BatchResult::valid() const noexcept {
    return std::all_of(entries.begin(), entries.end(),
                       [](const Entry& entry) { return entry.normalized.valid(); });
}

NormalizeResult normalize_identifier(std::string_view input, const NormalizeOptions& options) {
    return Normalizer(options).normalize(input);
}

NormalizeResult normalize(std::string_view input, const NormalizeOptions& options) {
    return normalize_identifier(input, options);
}

BatchResult normalize_identifiers(std::span<const std::string_view> inputs,
                                  const NormalizeOptions& options) {
    const Normalizer normalizer(options);
    BatchResult batch;
    batch.entries.reserve(inputs.size());

    std::map<std::string, std::size_t> group_index;
    for (std::size_t i = 0; i < inputs.size(); ++i) {
        Entry entry;
        entry.original.assign(inputs[i].data(), inputs[i].size());
        entry.normalized = normalizer.normalize(inputs[i]);

        if (entry.normalized.valid()) {
            auto [position, inserted] =
                group_index.emplace(entry.normalized.key, batch.groups.size());
            if (inserted) {
                ConflictGroup group;
                group.key = entry.normalized.key;
                group.entries.push_back(i);
                group.distinct_originals.push_back(entry.original);
                batch.groups.push_back(std::move(group));
            } else {
                ConflictGroup& group = batch.groups[position->second];
                group.entries.push_back(i);
                if (std::find(group.distinct_originals.begin(), group.distinct_originals.end(),
                              entry.original) == group.distinct_originals.end()) {
                    group.distinct_originals.push_back(entry.original);
                }
            }
        }

        batch.entries.push_back(std::move(entry));
    }

    for (const ConflictGroup& group : batch.groups) {
        if (group.is_conflict()) {
            batch.conflicts.push_back(group);
        }
    }
    return batch;
}

BatchResult normalize_identifiers(std::span<const std::string> inputs,
                                  const NormalizeOptions& options) {
    std::vector<std::string_view> views;
    views.reserve(inputs.size());
    for (const std::string& input : inputs) {
        views.push_back(input);
    }
    return normalize_identifiers(std::span<const std::string_view>(views), options);
}

BatchResult normalize_identifiers(std::initializer_list<std::string_view> inputs,
                                  const NormalizeOptions& options) {
    return normalize_identifiers(
        std::span<const std::string_view>(inputs.begin(), inputs.size()), options);
}

std::vector<Utf8Error> validate_utf8(std::string_view input) {
    std::vector<Utf8Error> errors;
    const auto* bytes = reinterpret_cast<const unsigned char*>(input.data());
    std::size_t offset = 0;
    while (offset < input.size()) {
        const Decoded decoded = decode_one(bytes + offset, input.size() - offset);
        if (decoded.valid) {
            offset += decoded.length;
        } else {
            errors.push_back({{offset, offset + decoded.length}});
            offset += decoded.length;
        }
    }
    return errors;
}

std::string to_utf8(std::span<const CodePoint> code_points) {
    std::string output;
    output.reserve(code_points.size());
    for (const CodePoint& cp : code_points) {
        append_utf8(output, cp.value);
    }
    return output;
}

namespace unicode {

std::string_view version() noexcept {
    return tables::kUnicodeVersionString;
}

int canonical_combining_class(char32_t code_point) noexcept {
    return combining_class(code_point);
}

bool is_default_ignorable(char32_t code_point) noexcept {
    return default_ignorable(code_point);
}

std::string_view script(char32_t code_point) noexcept {
    return tables::kScriptNames[script_id(code_point)];
}

std::vector<std::string_view> script_extensions(char32_t code_point) {
    std::vector<std::string_view> scripts;
    const auto* extensions = find_script_extensions(code_point);
    if (extensions == nullptr) {
        scripts.push_back(script(code_point));
        return scripts;
    }
    scripts.reserve(extensions->count);
    for (std::uint32_t i = 0; i < extensions->count; ++i) {
        scripts.push_back(tables::kScriptNames[tables::kScxData[extensions->offset + i]]);
    }
    return scripts;
}

}  // namespace unicode

}  // namespace dataeng
