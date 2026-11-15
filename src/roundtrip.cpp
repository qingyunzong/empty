#include "dataeng/roundtrip.hpp"

#include <map>

namespace dataeng {

namespace {

using wire::RawField;

// Group every occurrence of a field number in wire order. Repeated fields
// naturally produce several entries.
std::map<int, std::vector<std::string_view>> GroupByNumber(
    const std::vector<RawField>& fields) {
  std::map<int, std::vector<std::string_view>> out;
  for (const RawField& f : fields) {
    out[f.number].push_back(f.payload);
  }
  return out;
}

bool SamePayloads(const std::vector<std::string_view>& a,
                  const std::vector<std::string_view>& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

}  // namespace

Status VerifyRoundTrip(const MigrationPlan& forward, std::string_view src,
                       RoundTripResult& result) {
  result = RoundTripResult{};

  std::unique_ptr<MigrationPlan> reverse;
  if (Status s = MigrationPlan::BuildReverse(forward, reverse); !s.ok()) {
    return s;
  }

  std::string middle;
  if (Status s = Transform(forward, src, middle, result.forward_stats);
      !s.ok()) {
    return s;
  }
  std::string back;
  if (Status s =
          Transform(*reverse, middle, back, result.reverse_stats);
      !s.ok()) {
    return s;
  }

  std::vector<RawField> original_fields;
  std::vector<RawField> roundtrip_fields;
  if (Status s = wire::ParseMessage(src, original_fields); !s.ok()) return s;
  if (Status s = wire::ParseMessage(back, roundtrip_fields); !s.ok()) return s;

  auto original = GroupByNumber(original_fields);
  auto roundtripped = GroupByNumber(roundtrip_fields);

  const bool plan_irreversible = forward.report().has_irreversible();

  for (const auto& [number, payloads] : original) {
    auto rt_it = roundtripped.find(number);
    if (rt_it == roundtripped.end() ||
        !SamePayloads(payloads, rt_it->second)) {
      const bool is_known =
          forward.src().FindByNumber(number) != nullptr;
      if (!is_known) {
        // Unknown/extension bytes must always survive untouched. Any
        // divergence here is a hard failure of the preservation guarantee.
        result.diverged_unknown_numbers.push_back(number);
      } else if (plan_irreversible) {
        // Mapped field diverged: expected when the plan itself documented an
        // irreversible change touching the schema.
        result.diverged_mapped_numbers.push_back(number);
      } else {
        // Reversible plans must restore every mapped field exactly.
        result.diverged_mapped_numbers.push_back(number);
      }
    }
  }

  // A field appearing only after the round trip is also drift (e.g. a
  // destination-only field emitted by a reverse transform).
  for (const auto& [number, payloads] : roundtripped) {
    if (original.find(number) == original.end()) {
      result.diverged_mapped_numbers.push_back(number);
    }
  }

  result.equivalent =
      result.diverged_unknown_numbers.empty() &&
      (result.diverged_mapped_numbers.empty() || plan_irreversible);
  return Status::Ok();
}

}  // namespace dataeng
