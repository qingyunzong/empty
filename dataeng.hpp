#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace dataeng {

using RecordId = std::uint64_t;
using Generation = std::uint64_t;

// Identity of the stream a bookmark belongs to. A bookmark may only be
// restored when all four components still match the active binding.
struct ChannelBinding {
    std::string channel;
    std::string provider;
    std::string query_version;

    bool operator==(const ChannelBinding&) const = default;
};

struct EventRecord {
    std::string channel;
    RecordId record_id = 0;
    std::string provider;
    std::string query_version;
    std::string payload;
    std::chrono::system_clock::time_point timestamp{};
};

struct DeliveredRecord {
    EventRecord record;
    Generation generation = 0;
};

struct Bookmark {
    std::string channel;
    // No value means "the beginning of this generation". Once records have
    // been delivered this is the last delivered record id.
    std::optional<RecordId> record_id;
    std::string provider;
    std::string query_version;
    Generation generation = 0;

    bool operator==(const Bookmark&) const = default;

    [[nodiscard]] std::string serialize() const;
    [[nodiscard]] static std::optional<Bookmark> deserialize(std::string_view text);
};

struct CoordinatorOptions {
    // With strict merging enabled, subscription records are buffered until a
    // backfill watermark proves that no smaller record id is still missing.
    // Call complete_backfill() (or drain_pending()) to switch to live delivery
    // when no backfill query is needed.
    bool strict_merge = true;

    // A subscription record from an unknown provider can implicitly start a
    // new generation. Disabled by default because provider changes are usually
    // an explicit channel-rebuild signal; a stale record must not be able to
    // move the coordinator to a different generation.
    bool auto_generation_on_provider_change = false;

    // Generation persisted alongside the channel metadata at process start.
    Generation initial_generation = 1;
};

enum class BookmarkStatus {
    accepted,
    channel_mismatch,
    provider_mismatch,
    query_version_mismatch,
    generation_mismatch,
};

[[nodiscard]] std::string_view to_string(BookmarkStatus status) noexcept;

struct RestoreResult {
    BookmarkStatus status = BookmarkStatus::generation_mismatch;
    // Effective cursor after applying the bookmark. nullopt means the caller
    // must start at the beginning of the current generation; an old bookmark
    // is never allowed to suppress newly created records.
    std::optional<RecordId> resume_after;

    [[nodiscard]] bool accepted() const noexcept {
        return status == BookmarkStatus::accepted;
    }
};

enum class RejectReason {
    none,
    channel_mismatch,
    provider_mismatch,
    query_version_mismatch,
    duplicate,
};

[[nodiscard]] std::string_view to_string(RejectReason reason) noexcept;

struct IngestOutcome {
    std::size_t accepted = 0;
    std::size_t duplicates = 0;
    std::size_t rejected = 0;
    RejectReason first_rejection = RejectReason::none;

    // Records that became deliverable as a result of this call, ordered by
    // generation and then by record id. Each record id is delivered once.
    std::vector<DeliveredRecord> ready;

    [[nodiscard]] bool any_accepted() const noexcept { return accepted != 0; }
    [[nodiscard]] bool ok() const noexcept { return rejected == 0; }
};

struct GenerationTransition {
    Generation previous_generation = 0;
    Generation new_generation = 0;
    // Pending records from the old generation are flushed in record-id order
    // before the generation switch so that a clear/rebuild cannot lose audit
    // records that were already received.
    std::vector<DeliveredRecord> flushed;
};

// Single-channel bookmark coordinator. Instantiate one per Event Log channel.
// The class is thread-safe; callbacks may feed it from subscription and
// backfill threads concurrently.
class BookmarkCoordinator {
public:
    explicit BookmarkCoordinator(ChannelBinding binding,
                                 CoordinatorOptions options = {});
    BookmarkCoordinator(std::string channel,
                        std::string provider,
                        std::string query_version,
                        CoordinatorOptions options = {});

    [[nodiscard]] ChannelBinding binding_snapshot() const;
    [[nodiscard]] Generation generation() const;
    [[nodiscard]] std::size_t pending_count() const;
    [[nodiscard]] std::optional<RecordId> last_delivered_record_id() const;

    // Validates the bookmark against channel, provider, query version and
    // generation. Only an accepted bookmark advances the cursor.
    RestoreResult restore_bookmark(const Bookmark& bookmark);

    // Snapshot of the last delivered record. Records that are only buffered or
    // still waiting for backfill are deliberately not included.
    [[nodiscard]] Bookmark snapshot_bookmark() const;

    // Declares that a backfill query starts after after_record_id. Subscription
    // records above that point are held until a later watermark covers them.
    std::vector<DeliveredRecord> begin_backfill(RecordId after_record_id = 0);

    // No unfetched record <= covered_through remains. Emits every buffered
    // record that is now safe to deliver, in ascending record-id order.
    std::vector<DeliveredRecord> advance_backfill(RecordId covered_through);

    // The backfill query has reached its end. Buffered records are emitted and
    // subsequent subscription records are delivered live.
    std::vector<DeliveredRecord> complete_backfill();

    // Alias for complete_backfill(): drain everything currently buffered and
    // switch to live delivery.
    std::vector<DeliveredRecord> drain_pending();

    // Live subscription callback input.
    IngestOutcome ingest_subscription(EventRecord record);

    // Backfill page input. When covered_through is absent, the highest record
    // id in this page is used as the watermark. complete=true finishes the
    // backfill and emits all buffered records.
    IngestOutcome ingest_backfill(std::span<const EventRecord> records,
                                  std::optional<RecordId> covered_through = std::nullopt,
                                  bool complete = false);

    // Log clear (same provider) or channel rebuild (optionally with a new
    // provider/query version) starts a new generation. Old bookmarks no longer
    // validate and the new generation starts with an empty cursor.
    GenerationTransition on_log_cleared();
    GenerationTransition on_channel_rebuilt(std::string new_provider = {},
                                            std::string new_query_version = {});

private:
    bool normalize_record_locked(EventRecord& record,
                                 IngestOutcome& outcome) const;
    void enqueue_locked(EventRecord record, IngestOutcome& outcome);
    std::vector<DeliveredRecord> emit_ready_locked(bool all);
    GenerationTransition transition_locked(std::string new_provider,
                                           std::string new_query_version);
    void reset_cursor_locked();

    mutable std::mutex mutex_;
    ChannelBinding binding_;
    CoordinatorOptions options_;
    Generation generation_ = 1;

    std::map<RecordId, EventRecord> pending_;
    std::optional<RecordId> last_delivered_;
    RecordId watermark_ = 0;
    bool live_ = false;
    std::unordered_set<std::string> retired_providers_;
};

using EventLogBookmarkCoordinator = BookmarkCoordinator;

[[nodiscard]] std::string bookmark_to_string(const Bookmark& bookmark);
[[nodiscard]] std::optional<Bookmark> bookmark_from_string(std::string_view text);

}  // namespace dataeng
