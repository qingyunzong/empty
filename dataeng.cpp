#include "dataeng.hpp"

#include <optional>
#include <utility>

namespace dataeng {
namespace {

std::optional<std::int64_t> rowKey(const Row& row) { return row.key; }

}  // namespace

void graceHashJoin(const std::vector<Row>& left,
                   const std::vector<Row>& right,
                   JoinType type,
                   const JoinConfig& config,
                   JoinSink sink,
                   JoinStats* stats) {
    graceHashJoin(left, right, rowKey, rowKey, type, config,
                  std::move(sink), stats);
}

void nestedLoopJoin(const std::vector<Row>& left,
                    const std::vector<Row>& right,
                    JoinType type,
                    JoinSink sink) {
    nestedLoopJoin(left, right, rowKey, rowKey, type, std::move(sink));
}

}  // namespace dataeng
