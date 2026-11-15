#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "schema.hpp"
#include "value.hpp"

namespace dataeng {

struct LevelEntry {
    int repetition = 0;
    int definition = 0;
    bool hasValue = false;
    ValuePtr value;

    LevelEntry() = default;
    LevelEntry(int rep, int def, bool present, ValuePtr entryValue)
        : repetition(rep), definition(def), hasValue(present),
          value(std::move(entryValue)) {}
    LevelEntry(LevelEntry&&) = default;
    LevelEntry& operator=(LevelEntry&&) = default;
    LevelEntry(const LevelEntry& other)
        : repetition(other.repetition), definition(other.definition),
          hasValue(other.hasValue),
          value(other.value ? other.value->clone() : nullptr) {}
    LevelEntry& operator=(const LevelEntry& other) {
        if (this != &other) {
            repetition = other.repetition;
            definition = other.definition;
            hasValue = other.hasValue;
            value = other.value ? other.value->clone() : nullptr;
        }
        return *this;
    }
};

struct LevelPage {
    std::vector<LevelEntry> entries;
};

struct DecodeStatus {
    bool ok = true;
    std::string message;
    std::size_t globalIndex = 0;
    std::size_t pageIndex = 0;
    std::size_t indexInPage = 0;

    explicit operator bool() const { return ok; }
    static DecodeStatus success() { return DecodeStatus{}; }
    static DecodeStatus failure(std::string msg, std::size_t global,
                                std::size_t page, std::size_t inPage) {
        return DecodeStatus{false, std::move(msg), global, page, inPage};
    }
};

struct EncodeStatus {
    bool ok = true;
    std::string message;

    explicit operator bool() const { return ok; }
    static EncodeStatus success() { return EncodeStatus{}; }
    static EncodeStatus failure(std::string msg) { return EncodeStatus{false, std::move(msg)}; }
};

class LevelEncoder {
public:
    LevelEncoder(const Schema& schema, const SchemaNode& leaf);

    EncodeStatus appendRow(const Value& rowValue);
    const std::vector<LevelEntry>& output() const { return output_; }
    void clear() { output_.clear(); }

    static EncodeStatus encodeColumn(const Schema& schema, const SchemaNode& leaf,
                                     const std::vector<ValuePtr>& rows,
                                     std::vector<LevelEntry>& out);

private:
    EncodeStatus walk(const SchemaNode& node, const Value* nodeValue, int rep);

    const SchemaNode* root_;
    const SchemaNode* leaf_;
    std::vector<const SchemaNode*> path_;
    std::vector<LevelEntry> output_;
    bool emitted_ = false;
};

class LevelDecoder {
public:
    LevelDecoder(const Schema& schema, const SchemaNode& leaf);

    DecodeStatus feedPage(const LevelPage& page);
    DecodeStatus feedPage(const std::vector<LevelEntry>& entries);
    DecodeStatus feedEntry(const LevelEntry& entry);

    DecodeStatus finish();

    const std::vector<ValuePtr>& rows() const { return rows_; }
    std::vector<ValuePtr> takeRows();

    std::size_t entriesConsumed() const { return consumed_; }
    std::size_t pagesConsumed() const { return pagesConsumed_; }

    void reset();

private:
    struct Frame {
        enum Role {
            StructField = 0,
            ListElements = 1,
            MapPairs = 2,
            MapPairStruct = 3,
            TransparentElement = 4,
        };
        const SchemaNode* node;
        int role;
        Value* container;
    };

    DecodeStatus process(const LevelEntry& entry, std::size_t global,
                         std::size_t page, std::size_t inPage);
    void resetStackForRow();
    DecodeStatus walkToLeaf(const LevelEntry& entry, std::size_t global,
                            std::size_t page, std::size_t inPage);
    DecodeStatus fail(std::string message, std::size_t global,
                      std::size_t page, std::size_t inPage);

    const SchemaNode* root_;
    const SchemaNode* leaf_;
    std::vector<const SchemaNode*> path_;
    std::vector<Frame> stack_;
    std::vector<ValuePtr> rows_;
    ValuePtr currentRow_;
    std::size_t consumed_ = 0;
    std::size_t pagesConsumed_ = 0;
    std::size_t rowIndex_ = 0;
    bool failed_ = false;
};

class RecordAssembler {
public:
    explicit RecordAssembler(const Schema& schema);

    DecodeStatus appendColumn(const SchemaNode& leaf,
                              const std::vector<ValuePtr>& leafRows);
    DecodeStatus appendColumn(const std::string& leafPathDot,
                              const std::vector<ValuePtr>& leafRows);

    const std::vector<ValuePtr>& records() const { return records_; }
    std::vector<ValuePtr> takeRecords();

private:
    static void placeLeaf(Value& row, const std::vector<const SchemaNode*>& path,
                          std::size_t depth, ValuePtr leafValue);

    const Schema& schema_;
    std::vector<ValuePtr> records_;
};

std::string toString(const Value& value);

}  // namespace dataeng
