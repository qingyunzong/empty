#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng::xml {

struct SlicerConfig {
    std::vector<std::string> target_paths;
    std::size_t entity_expansion_budget = 10u * 1024u * 1024u;
};

struct Slice {
    std::string path;
    std::string raw;
    std::size_t start_offset = 0;
    std::size_t end_offset = 0;
};

struct UnclosedElement {
    std::string qname;
    std::string resolved_path;
    std::size_t start_offset = 0;
};

enum class ErrorCode {
    None,
    Malformed,
    ExternalEntity,
    UndefinedEntity,
    EntityRecursion,
    EntityBudgetExceeded,
    EncodingNotSupported,
};

struct ParseError {
    ErrorCode code = ErrorCode::None;
    std::string message;
    std::size_t offset = 0;
};

class XmlSlicer {
public:
    explicit XmlSlicer(SlicerConfig config = {});
    ~XmlSlicer();

    XmlSlicer(const XmlSlicer&) = delete;
    XmlSlicer& operator=(const XmlSlicer&) = delete;

    bool feed(const char* data, std::size_t len);
    bool feed(std::string_view chunk);

    bool finish();

    std::vector<Slice> take_slices();

    const std::vector<UnclosedElement>& unclosed() const noexcept;

    bool has_error() const noexcept;
    const ParseError& error() const noexcept;

    std::size_t bytes_fed() const noexcept;
    std::size_t entity_expansion_used() const noexcept;
    std::size_t entity_expansion_budget() const noexcept;

private:
    struct Impl;
    Impl* impl_;
};

}  // namespace dataeng::xml
