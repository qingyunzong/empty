#pragma once

#include <cstddef>
#include <exception>
#include <memory>
#include <optional>
#include <queue>
#include <utility>
#include <vector>

namespace kway {

// A cursor over one ordered source. Records must be produced in
// non-decreasing key order.
template <typename Key, typename Value>
class Cursor {
public:
    virtual ~Cursor() = default;

    // Advances to the next record. Returns false when the source is
    // exhausted. May throw to signal a source failure.
    virtual bool next() = 0;

    // Key/value of the current record. Valid until the next next()/close().
    virtual const Key& key() const = 0;
    virtual const Value& value() const = 0;

    // Releases the source. Must be idempotent and must not throw.
    virtual void close() noexcept = 0;
};

enum class Status {
    Ok,          // record holds the next merged record
    Paused,      // merger is paused; no source was touched
    SourceError, // a source failed; error_source/error describe it
    Done,        // merge finished (exhausted or cancelled)
};

template <typename Key, typename Value>
struct Record {
    Key key;
    std::size_t source;
    Value value;
};

template <typename Key, typename Value>
struct Result {
    Status status = Status::Done;
    std::optional<Record<Key, Value>> record; // set when status == Ok
    std::size_t error_source = 0;             // set when status == SourceError
    std::exception_ptr error;                 // set when status == SourceError
};

// Merges K ordered cursors into one stream ordered by (key, source).
//
// - At most one unconsumed record is held per source at any time.
// - A failed source is closed, reported via Status::SourceError, and
//   dropped; the merge continues with the remaining sources.
// - cancel() releases every cursor exactly once and is idempotent;
//   the destructor cancels automatically.
template <typename Key, typename Value>
class Merger {
public:
    using CursorT = Cursor<Key, Value>;

    explicit Merger(std::vector<std::unique_ptr<CursorT>> cursors) {
        entries_.reserve(cursors.size());
        for (auto& cursor : cursors) {
            Entry entry;
            entry.cursor = std::move(cursor);
            entry.source = entries_.size();
            entries_.push_back(std::move(entry));
        }
    }

    Merger(const Merger&) = delete;
    Merger& operator=(const Merger&) = delete;

    ~Merger() { cancel(); }

    void pause() { paused_ = true; }
    void resume() { paused_ = false; }
    bool paused() const { return paused_; }

    // Releases every cursor exactly once. Idempotent; safe to call
    // multiple times and from any state.
    void cancel() noexcept {
        if (cancelled_) {
            return;
        }
        cancelled_ = true;
        clearHeap();
        for (auto& entry : entries_) {
            closeEntry(entry);
        }
        std::queue<PendingError> empty;
        pending_errors_.swap(empty);
    }

    Result<Key, Value> next() {
        Result<Key, Value> result;
        if (cancelled_) {
            result.status = Status::Done;
            return result;
        }
        if (paused_) {
            result.status = Status::Paused;
            return result;
        }
        if (!primed_) {
            prime();
            primed_ = true;
        }
        if (!pending_errors_.empty()) {
            const PendingError pending = pending_errors_.front();
            pending_errors_.pop();
            result.status = Status::SourceError;
            result.error_source = pending.source;
            result.error = pending.error;
            return result;
        }
        if (heap_.empty()) {
            result.status = Status::Done;
            return result;
        }

        const HeapItem top = heap_.top();
        heap_.pop();
        Entry& entry = entries_[top.source];

        Record<Key, Value> record{top.key, top.source, entry.cursor->value()};
        refill(entry);

        result.status = Status::Ok;
        result.record = std::move(record);
        return result;
    }

    std::size_t size() const { return entries_.size(); }

private:
    struct Entry {
        std::unique_ptr<CursorT> cursor;
        std::size_t source = 0;
        bool closed = false;
    };

    struct HeapItem {
        Key key;
        std::size_t source;
    };

    // Orders by key, breaking ties by source number (min-heap).
    struct HeapGreater {
        bool operator()(const HeapItem& lhs, const HeapItem& rhs) const {
            if (rhs.key < lhs.key) {
                return true;
            }
            if (lhs.key < rhs.key) {
                return false;
            }
            return lhs.source > rhs.source;
        }
    };

    struct PendingError {
        std::size_t source;
        std::exception_ptr error;
    };

    void prime() {
        for (auto& entry : entries_) {
            refill(entry);
        }
    }

    // Pulls at most one record from the source, so each source keeps at
    // most one unconsumed record. Failures are queued, never thrown.
    void refill(Entry& entry) {
        if (entry.closed) {
            return;
        }
        bool has_more = false;
        try {
            has_more = entry.cursor->next();
        } catch (...) {
            pending_errors_.push({entry.source, std::current_exception()});
            closeEntry(entry);
            return;
        }
        if (has_more) {
            heap_.push({entry.cursor->key(), entry.source});
        } else {
            closeEntry(entry);
        }
    }

    void closeEntry(Entry& entry) noexcept {
        if (entry.closed) {
            return;
        }
        entry.closed = true;
        entry.cursor->close();
    }

    void clearHeap() {
        std::priority_queue<HeapItem, std::vector<HeapItem>, HeapGreater> empty;
        heap_.swap(empty);
    }

    std::vector<Entry> entries_;
    std::priority_queue<HeapItem, std::vector<HeapItem>, HeapGreater> heap_;
    std::queue<PendingError> pending_errors_;
    bool primed_ = false;
    bool paused_ = false;
    bool cancelled_ = false;
};

} // namespace kway
