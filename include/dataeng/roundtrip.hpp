#pragma once

#include <string>
#include <vector>

#include "dataeng/migration.hpp"
#include "dataeng/status.hpp"
#include "dataeng/transform.hpp"
#include "dataeng/wire.hpp"

// Round-trip verification helpers.
namespace dataeng {

struct RoundTripResult {
  bool equivalent = false;
  // Field numbers whose bytes could not be restored (mapped fields involved
  // in an irreversible change). Empty for a fully reversible plan.
  std::vector<int> diverged_mapped_numbers;
  // Field numbers of unknown/extension fields; populated when any of them
  // failed to survive the round trip byte-for-byte.
  std::vector<int> diverged_unknown_numbers;
  TransformStats forward_stats;
  TransformStats reverse_stats;
};

// Run forward then reverse transformation and verify that:
//   1. every unknown field (numbers not declared by either descriptor) keeps
//      identical wire bytes after the round trip,
//   2. mapped fields round-trip to their original number/payload whenever the
//      plan reports no irreversible change touching them.
Status VerifyRoundTrip(const MigrationPlan& forward, std::string_view src,
                       RoundTripResult& result);

}  // namespace dataeng
