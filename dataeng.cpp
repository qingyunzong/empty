#include "dataeng.hpp"

#include <algorithm>
#include <charconv>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <utility>

namespace dataeng {
namespace {

constexpr std::string_view kBookmarkPrefix = "dataeng-bookmark/1";

bool is_unreserved(char value) noexcept {
    return (value >= 'A' && value <= 'Z') ||
           (value >= 'a' && value <= 'z') ||
           (value >= '0' && value <= '9') ||
           value == '-' || value == '_' || value == '.' || value == '~';
}

int hex_value(char value) noexcept {
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    return -1;
}

std::string percent_encode(std::string_view value) {
    constexpr char kHex[] = "0123456789ABCDEF";
    std::string encoded;
    encoded.reserve(value.size());
    for (const char character : value) {
        const auto byte = static_cast<unsigned char>(character);
        if (is_unreserved(character)) {
            encoded.push_back(character);
        } else {
            encoded.push_back('%');
            encoded.push_back(kHex[(byte >> 4U) & 0x0FU]);
            encoded.push_back(kHex[byte & 0x0FU]);
        }
    }
    return encoded;
}

std::optional<std::string> percent_decode(std::string_view value) {
    std::string decoded;
    decoded.reserve(value.size());
    for (std::size_t index = 0; index < value.size(); ++index) {
        if (value[index] != '%') {
            decoded.push_back(value[index]);
            continue;
        }
        if (index + 2 >= value.size()) {
            return std::nullopt;
        }
        const int high = hex_value(value[index + 1]);
        const int low = hex_value(value[index + 2]);
        if (high < 0 || low < 0) {
            return std::nullopt;
        }
        decoded.push_back(static_cast<char>((high << 4) | low));
        index += 2;
    }
    return decoded;
}

std::vector<std::string_view> split(std::string_view value, char separator) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    while (true) {
        const std::size_t position = value.find(separator, start);
        if (position == std::string_view::npos) {
            parts.push_back(value.substr(start));
            break;
        }
        parts.push_back(value.substr(start, position - start));
        start = position + 1;
    }
    return parts;
}

bool parse_uint64(std::string_view text, std::uint64_t& value) {
    if (text.empty()) {
        return false;
    }
    const char* begin = text.data();
    const char* end = begin + text.size();
    const auto result = std::from_chars(begin, end, value);
    return result.ec == std::errc{} && result.ptr == end;
}

}  // namespace

std::string_view to_string(BookmarkStatus status) noexcept {
    switch (status) {
        case BookmarkStatus::accepted:
            return "accepted";
        case BookmarkStatus::channel_mismatch:
            return "channel_mismatch";
        case BookmarkStatus::provider_mismatch:
            return "provider_mismatch";
        case BookmarkStatus::query_version_mismatch:
            return "query_version_mismatch";
        case BookmarkStatus::generation_mismatch:
            return "generation_mismatch";
    }
    return "unknown";
}

std::string_view to_string(RejectReason reason) noexcept {
    switch (reason) {
        case RejectReason::none:
            return "none";
        case RejectReason::channel_mismatch:
            return "channel_mismatch";
        case RejectReason::provider_mismatch:
            return "provider_mismatch";
        case RejectReason::query_version_mismatch:
            return "query_version_mismatch";
        case RejectReason::duplicate:
            return "duplicate";
    }
    return "unknown";
}

std::string bookmark_to_string(const Bookmark& bookmark) {
    std::string text;
    text.reserve(128);
    text.append(kBookmarkPrefix);
    text.push_back('|');
    text.append(percent_encode(bookmark.channel));
    text.push_back('|');
    if (bookmark.record_id) {
        text.append(std::to_string(*bookmark.record_id));
    } else {
        text.push_back('-');
    }
    text.push_back('|');
    text.append(percent_encode(bookmark.provider));
    text.push_back('|');
    text.append(percent_encode(bookmark.query_version));
    text.push_back('|');
    text.append(std::to_string(bookmark.generation));
    return text;
}

std::optional<Bookmark> bookmark_from_string(std::string_view text) {
    const std::vector<std::string_view> parts = split(text, '|');
    if (parts.size() != 6 || parts[0] != kBookmarkPrefix) {
        return std::nullopt;
    }

    auto channel = percent_decode(parts[1]);
    auto provider = percent_decode(parts[3]);
    auto query_version = percent_decode(parts[4]);
    if (!channel || !provider || !query_version) {
        return std::nullopt;
    }

    Bookmark bookmark;
    bookmark.channel = std::move(*channel);
    bookmark.provider = std::move(*provider);
    bookmark.query_version = std::move(*query_version);

    if (parts[2] != "-") {
        RecordId record_id = 0;
        if (!parse_uint64(parts[2], record_id)) {
            return std::nullopt;
        }
        bookmark.record_id = record_id;
    }

    Generation generation = 0;
    if (!parse_uint64(parts[5], generation) || generation == 0) {
        return std::nullopt;
    }
    bookmark.generation = generation;
    return bookmark;
}

std::string Bookmark::serialize() const {
    return bookmark_to_string(*this);
}

std::optional<Bookmark> Bookmark::deserialize(std::string_view text) {
    return bookmark_from_string(text);
}

BookmarkCoordinator::BookmarkCoordinator(ChannelBinding binding,
                                         CoordinatorOptions options)
    : binding_(std::move(binding)), options_(options) {
    if (binding_.channel.empty()) {
        throw std::invalid_argument("BookmarkCoordinator requires a channel");
    }
    if (options_.initial_generation == 0) {
        options_.initial_generation = 1;
    }
    generation_ = options_.initial_generation;
    live_ = !options_.strict_merge;
}

BookmarkCoordinator::BookmarkCoordinator(std::string channel,
                                         std::string provider,
                                         std::string query_version,
                                         CoordinatorOptions options)
    : BookmarkCoordinator(
          ChannelBinding{
              .channel = std::move(channel),
              .provider = std::move(provider),
              .query_version = std::move(query_version),
          },
          options) {}

ChannelBinding BookmarkCoordinator::binding_snapshot() const {
    const std::lock_guard lock(mutex_);
    return binding_;
}

Generation BookmarkCoordinator::generation() const {
    const std::lock_guard lock(mutex_);
    return generation_;
}

std::size_t BookmarkCoordinator::pending_count() const {
    const std::lock_guard lock(mutex_);
    return pending_.size();
}

std::optional<RecordId> BookmarkCoordinator::last_delivered_record_id() const {
    const std::lock_guard lock(mutex_);
    return last_delivered_;
}

RestoreResult BookmarkCoordinator::restore_bookmark(const Bookmark& bookmark) {
    const std::lock_guard lock(mutex_);

    if (bookmark.channel != binding_.channel) {
        return {BookmarkStatus::channel_mismatch, std::nullopt};
    }
    if (bookmark.provider != binding_.provider) {
        return {BookmarkStatus::provider_mismatch, std::nullopt};
    }
    if (bookmark.query_version != binding_.query_version) {
        return {BookmarkStatus::query_version_mismatch, std::nullopt};
    }
    if (bookmark.generation == 0 || bookmark.generation != generation_) {
        return {BookmarkStatus::generation_mismatch, std::nullopt};
    }

    if (bookmark.record_id &&
        (!last_delivered_ || *bookmark.record_id > *last_delivered_)) {
        last_delivered_ = bookmark.record_id;
    }

    if (last_delivered_) {
        watermark_ = std::max(watermark_, *last_delivered_);
        for (auto iterator = pending_.begin();
             iterator != pending_.end() && iterator->first <= *last_delivered_;) {
            iterator = pending_.erase(iterator);
        }
    }

    return {BookmarkStatus::accepted, last_delivered_};
}

Bookmark BookmarkCoordinator::snapshot_bookmark() const {
    const std::lock_guard lock(mutex_);
    return Bookmark{
        .channel = binding_.channel,
        .record_id = last_delivered_,
        .provider = binding_.provider,
        .query_version = binding_.query_version,
        .generation = generation_,
    };
}

std::vector<DeliveredRecord> BookmarkCoordinator::begin_backfill(
    RecordId after_record_id) {
    const std::lock_guard lock(mutex_);
    live_ = false;
    watermark_ = std::max(watermark_, after_record_id);
    return emit_ready_locked(false);
}

std::vector<DeliveredRecord> BookmarkCoordinator::advance_backfill(
    RecordId covered_through) {
    const std::lock_guard lock(mutex_);
    live_ = false;
    watermark_ = std::max(watermark_, covered_through);
    return emit_ready_locked(false);
}

std::vector<DeliveredRecord> BookmarkCoordinator::complete_backfill() {
    const std::lock_guard lock(mutex_);
    live_ = true;
    watermark_ = std::numeric_limits<RecordId>::max();
    return emit_ready_locked(true);
}

std::vector<DeliveredRecord> BookmarkCoordinator::drain_pending() {
    return complete_backfill();
}

IngestOutcome BookmarkCoordinator::ingest_subscription(EventRecord record) {
    const std::lock_guard lock(mutex_);
    IngestOutcome outcome;

    if (!record.channel.empty() && record.channel != binding_.channel) {
        outcome.rejected = 1;
        outcome.first_rejection = RejectReason::channel_mismatch;
        return outcome;
    }
    if (!record.query_version.empty() &&
        record.query_version != binding_.query_version) {
        outcome.rejected = 1;
        outcome.first_rejection = RejectReason::query_version_mismatch;
        return outcome;
    }

    const std::string provider = record.provider;
    if (!provider.empty() && provider != binding_.provider) {
        if (options_.auto_generation_on_provider_change &&
            retired_providers_.find(provider) == retired_providers_.end()) {
            GenerationTransition transition =
                transition_locked(provider, std::string{});
            outcome.ready = std::move(transition.flushed);
        } else {
            outcome.rejected = 1;
            outcome.first_rejection = RejectReason::provider_mismatch;
            return outcome;
        }
    }

    if (!normalize_record_locked(record, outcome)) {
        return outcome;
    }
    enqueue_locked(std::move(record), outcome);

    std::vector<DeliveredRecord> ready = emit_ready_locked(live_);
    outcome.ready.insert(outcome.ready.end(),
                         std::make_move_iterator(ready.begin()),
                         std::make_move_iterator(ready.end()));
    return outcome;
}

IngestOutcome BookmarkCoordinator::ingest_backfill(
    std::span<const EventRecord> records,
    std::optional<RecordId> covered_through,
    bool complete) {
    const std::lock_guard lock(mutex_);
    IngestOutcome outcome;

    live_ = false;
    RecordId page_max = 0;
    for (const EventRecord& source : records) {
        EventRecord record = source;
        if (normalize_record_locked(record, outcome)) {
            page_max = std::max(page_max, record.record_id);
            enqueue_locked(std::move(record), outcome);
        }
    }

    if (covered_through) {
        watermark_ = std::max(watermark_, *covered_through);
    } else if (!records.empty()) {
        watermark_ = std::max(watermark_, page_max);
    }

    if (complete) {
        live_ = true;
        watermark_ = std::numeric_limits<RecordId>::max();
    }

    outcome.ready = emit_ready_locked(live_);
    return outcome;
}

GenerationTransition BookmarkCoordinator::on_log_cleared() {
    const std::lock_guard lock(mutex_);
    return transition_locked(std::string{}, std::string{});
}

GenerationTransition BookmarkCoordinator::on_channel_rebuilt(
    std::string new_provider,
    std::string new_query_version) {
    const std::lock_guard lock(mutex_);
    return transition_locked(std::move(new_provider),
                             std::move(new_query_version));
}

bool BookmarkCoordinator::normalize_record_locked(EventRecord& record,
                                                  IngestOutcome& outcome) const {
    if (!record.channel.empty() && record.channel != binding_.channel) {
        ++outcome.rejected;
        if (outcome.first_rejection == RejectReason::none) {
            outcome.first_rejection = RejectReason::channel_mismatch;
        }
        return false;
    }
    if (!record.provider.empty() && record.provider != binding_.provider) {
        ++outcome.rejected;
        if (outcome.first_rejection == RejectReason::none) {
            outcome.first_rejection = RejectReason::provider_mismatch;
        }
        return false;
    }
    if (!record.query_version.empty() &&
        record.query_version != binding_.query_version) {
        ++outcome.rejected;
        if (outcome.first_rejection == RejectReason::none) {
            outcome.first_rejection = RejectReason::query_version_mismatch;
        }
        return false;
    }

    record.channel = binding_.channel;
    record.provider = binding_.provider;
    record.query_version = binding_.query_version;
    return true;
}

void BookmarkCoordinator::enqueue_locked(EventRecord record,
                                         IngestOutcome& outcome) {
    if (last_delivered_ && record.record_id <= *last_delivered_) {
        ++outcome.duplicates;
        return;
    }
    const auto [iterator, inserted] =
        pending_.emplace(record.record_id, std::move(record));
    (void)iterator;
    if (!inserted) {
        ++outcome.duplicates;
        return;
    }
    ++outcome.accepted;
}

std::vector<DeliveredRecord> BookmarkCoordinator::emit_ready_locked(bool all) {
    std::vector<DeliveredRecord> ready;
    while (!pending_.empty()) {
        auto iterator = pending_.begin();
        if (!all && iterator->first > watermark_) {
            break;
        }
        if (last_delivered_ && iterator->first <= *last_delivered_) {
            pending_.erase(iterator);
            continue;
        }

        EventRecord record = std::move(iterator->second);
        pending_.erase(iterator);
        last_delivered_ = record.record_id;
        ready.push_back(DeliveredRecord{
            .record = std::move(record),
            .generation = generation_,
        });
    }
    return ready;
}

GenerationTransition BookmarkCoordinator::transition_locked(
    std::string new_provider,
    std::string new_query_version) {
    if (generation_ == std::numeric_limits<Generation>::max()) {
        throw std::overflow_error("Event Log generation counter exhausted");
    }

    GenerationTransition transition{
        .previous_generation = generation_,
        .new_generation = generation_ + 1,
        .flushed = emit_ready_locked(true),
    };

    if (!new_provider.empty()) {
        if (!binding_.provider.empty() && binding_.provider != new_provider) {
            retired_providers_.insert(binding_.provider);
        }
        retired_providers_.erase(new_provider);
        binding_.provider = std::move(new_provider);
    }
    if (!new_query_version.empty()) {
        binding_.query_version = std::move(new_query_version);
    }

    ++generation_;
    reset_cursor_locked();
    return transition;
}

void BookmarkCoordinator::reset_cursor_locked() {
    pending_.clear();
    last_delivered_.reset();
    watermark_ = 0;
    live_ = !options_.strict_merge;
}

}  // namespace dataeng
