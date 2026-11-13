#include "dataeng.hpp"

#include <stdexcept>

namespace dataeng {
namespace {

constexpr unsigned char kUtf8Bom[] = {0xEF, 0xBB, 0xBF};

bool is_continuation(unsigned char byte) noexcept
{
    return (byte & 0xC0U) == 0x80U;
}

} // namespace

JsonLinesDecoder::JsonLinesDecoder()
    : JsonLinesDecoder(Options{})
{
}

JsonLinesDecoder::JsonLinesDecoder(Options options)
    : options_(options)
{
}

JsonLinesDecoder::JsonLinesDecoder(std::size_t max_line_bytes)
    : options_{}
{
    options_.max_line_bytes = max_line_bytes;
}

Result JsonLinesDecoder::feed(std::string_view chunk)
{
    if (finished_) {
        throw std::logic_error(
            "dataeng::JsonLinesDecoder::feed() called after finish()");
    }

    Result result;
    const std::uint64_t base = stream_offset_;
    stream_offset_ += static_cast<std::uint64_t>(chunk.size());

    std::size_t consumed = 0;
    if (!bom_settled_) {
        if (!options_.strip_bom) {
            bom_settled_ = true;
        } else {
            while (consumed < chunk.size() && bom_prefix_.size() < sizeof(kUtf8Bom)) {
                const auto byte =
                    static_cast<unsigned char>(chunk[consumed]);
                if (byte == kUtf8Bom[bom_prefix_.size()]) {
                    bom_prefix_.push_back(static_cast<char>(byte));
                    ++consumed;
                    if (bom_prefix_.size() == sizeof(kUtf8Bom)) {
                        bom_settled_ = true;
                        bom_prefix_.clear();
                    }
                } else {
                    // The bytes matched so far are ordinary input, not a BOM.
                    bom_settled_ = true;
                    std::string pending;
                    pending.swap(bom_prefix_);
                    if (!pending.empty()) {
                        process_bytes(pending, 0, result);
                    }
                    break;
                }
            }

            if (!bom_settled_) {
                // The whole chunk was a BOM prefix; wait for more bytes.
                return result;
            }
        }
    }

    if (consumed < chunk.size()) {
        process_bytes(chunk.substr(consumed), base + consumed, result);
    }
    return result;
}

Result JsonLinesDecoder::finish()
{
    if (finished_) {
        return {};
    }

    Result result;
    if (!bom_settled_) {
        bom_settled_ = true;
        if (!bom_prefix_.empty()) {
            std::string pending;
            pending.swap(bom_prefix_);
            process_bytes(pending, 0, result);
        }
    }

    if (line_active_) {
        finish_line(result);
    }

    finished_ = true;
    return result;
}

void JsonLinesDecoder::reset()
{
    bom_settled_ = false;
    bom_prefix_.clear();
    finished_ = false;
    stream_offset_ = 0;
    line_number_ = 1;
    std::string().swap(line_);
    line_start_ = 0;
    line_active_ = false;
    overflow_ = false;
    overflow_bytes_ = 0;
    last_was_cr_ = false;
}

void JsonLinesDecoder::process_bytes(std::string_view bytes,
                                     std::uint64_t base,
                                     Result& out)
{
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        const auto byte = static_cast<unsigned char>(bytes[i]);
        const std::uint64_t offset = base + i;

        if (byte == '\n') {
            if (!line_active_) {
                line_start_ = offset; // Empty physical line.
                line_active_ = true;
            }
            finish_line(out);
            ++line_number_;
            continue;
        }

        if (!line_active_) {
            line_active_ = true;
            line_start_ = offset;
        }

        if (overflow_) {
            ++overflow_bytes_;
            last_was_cr_ = (byte == '\r');
            continue;
        }

        if (options_.max_line_bytes != 0) {
            // A trailing CR may turn out to be part of CRLF, so it does not
            // consume the body budget until a following byte proves it is
            // content.
            const std::size_t content_if_line_ends =
                line_.size() + (byte == '\r' ? 0U : 1U);
            if (content_if_line_ends > options_.max_line_bytes) {
                overflow_ = true;
                overflow_bytes_ = line_.size() + 1;
                last_was_cr_ = (byte == '\r');
                // Drop the prefix immediately; never retain an oversized body.
                std::string().swap(line_);
                continue;
            }
        }

        line_.push_back(static_cast<char>(byte));
        last_was_cr_ = (byte == '\r');
    }
}

void JsonLinesDecoder::finish_line(Result& out)
{
    if (overflow_) {
        std::uint64_t content_bytes = overflow_bytes_;
        if (last_was_cr_ && content_bytes != 0) {
            --content_bytes;
        }
        out.errors.push_back(Error{ErrorKind::LineTooLong, line_start_,
                                   line_start_ + content_bytes, line_number_});
        discard_line();
        return;
    }

    if (!line_.empty() && line_.back() == '\r') {
        line_.pop_back();
    }

    if (line_.empty()) {
        if (!options_.skip_empty_lines && line_active_) {
            out.records.push_back(
                Record{std::move(line_), line_start_, line_start_, line_number_});
        }
        discard_line();
        return;
    }

    const auto first_error = out.errors.size();
    if (options_.validate_utf8) {
        report_utf8_errors(line_, line_start_, out);
    }
    if (out.errors.size() != first_error) {
        // A malformed record is dropped, but its terminator has already
        // established the next line boundary.
        discard_line();
        return;
    }

    const std::uint64_t end = line_start_ + line_.size();
    std::string text = std::move(line_);
    out.records.push_back(
        Record{std::move(text), line_start_, end, line_number_});
    discard_line();
}

void JsonLinesDecoder::discard_line()
{
    if (overflow_) {
        std::string().swap(line_);
    } else {
        line_.clear();
    }
    line_active_ = false;
    overflow_ = false;
    overflow_bytes_ = 0;
    last_was_cr_ = false;
}

void JsonLinesDecoder::report_utf8_errors(const std::string& bytes,
                                          std::uint64_t base,
                                          Result& out) const
{
    const std::size_t size = bytes.size();
    std::size_t i = 0;

    const auto emit = [&](std::size_t begin, std::size_t end) {
        out.errors.push_back(Error{ErrorKind::InvalidUtf8, base + begin,
                                   base + end, line_number_});
    };

    while (i < size) {
        const auto lead = static_cast<unsigned char>(bytes[i]);
        if (lead < 0x80U) {
            ++i;
            continue;
        }

        if (lead >= 0xC2U && lead <= 0xDFU) {
            if (i + 1 >= size) {
                emit(i, size);
                break;
            }
            if (!is_continuation(static_cast<unsigned char>(bytes[i + 1]))) {
                emit(i, i + 1);
                ++i;
                continue;
            }
            i += 2;
            continue;
        }

        if (lead >= 0xE0U && lead <= 0xEFU) {
            if (i + 1 >= size) {
                emit(i, size);
                break;
            }

            unsigned char low = 0x80U;
            unsigned char high = 0xBFU;
            if (lead == 0xE0U) {
                low = 0xA0U; // Reject overlong forms.
            } else if (lead == 0xEDU) {
                high = 0x9FU; // Reject UTF-16 surrogates.
            }

            const auto second = static_cast<unsigned char>(bytes[i + 1]);
            if (second < low || second > high) {
                emit(i, i + 1);
                ++i;
                continue;
            }
            if (i + 2 >= size) {
                emit(i, size);
                break;
            }
            if (!is_continuation(static_cast<unsigned char>(bytes[i + 2]))) {
                emit(i, i + 2);
                i += 2;
                continue;
            }
            i += 3;
            continue;
        }

        if (lead >= 0xF0U && lead <= 0xF4U) {
            if (i + 1 >= size) {
                emit(i, size);
                break;
            }

            unsigned char low = 0x80U;
            unsigned char high = 0xBFU;
            if (lead == 0xF0U) {
                low = 0x90U; // Reject overlong forms.
            } else if (lead == 0xF4U) {
                high = 0x8FU; // Reject code points above U+10FFFF.
            }

            const auto second = static_cast<unsigned char>(bytes[i + 1]);
            if (second < low || second > high) {
                emit(i, i + 1);
                ++i;
                continue;
            }
            if (i + 2 >= size) {
                emit(i, size);
                break;
            }
            if (!is_continuation(static_cast<unsigned char>(bytes[i + 2]))) {
                emit(i, i + 2);
                i += 2;
                continue;
            }
            if (i + 3 >= size) {
                emit(i, size);
                break;
            }
            if (!is_continuation(static_cast<unsigned char>(bytes[i + 3]))) {
                emit(i, i + 3);
                i += 3;
                continue;
            }
            i += 4;
            continue;
        }

        // Stray continuation byte, overlong two-byte lead, or an invalid lead.
        emit(i, i + 1);
        ++i;
    }
}

Result decode_json_lines(std::string_view input, Options options)
{
    JsonLinesDecoder decoder(options);
    Result result = decoder.feed(input);
    Result tail = decoder.finish();

    result.records.reserve(result.records.size() + tail.records.size());
    for (auto& record : tail.records) {
        result.records.push_back(std::move(record));
    }
    for (auto& error : tail.errors) {
        result.errors.push_back(error);
    }
    return result;
}

Result decode(std::string_view input, Options options)
{
    return decode_json_lines(input, options);
}

} // namespace dataeng
