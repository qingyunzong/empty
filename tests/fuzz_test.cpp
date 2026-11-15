#include "dataeng/dataeng.hpp"

#include <cstdint>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

namespace {

using namespace dataeng;
using dataeng::wire::WireType;

// Generate a syntactically valid protobuf message using field numbers that
// mix "known" and deliberately unknown/extension ranges.
std::string GenerateMessage(std::mt19937_64& rng) {
  std::uniform_int_distribution<int> field_dist(5, 120);
  std::uniform_int_distribution<int> wire_pick(0, 4);
  std::uniform_int_distribution<int> byte_dist(0, 255);
  std::uniform_int_distribution<int> len_dist(0, 32);

  std::string msg;
  int count = std::uniform_int_distribution<int>(0, 40)(rng);
  for (int i = 0; i < count; ++i) {
    int number = field_dist(rng);
    if (number >= 10 && number <= 40) {
      // Skip destination-known numbers so random-typed unknown fields cannot
      // collide with a declared destination field after renaming.
      number = number + 41;
    }
    // Known fields must use their descriptor's wire type; only unknown
    // numbers get a randomized (but self-consistent per occurrence) type.
    int pick;
    if (number == 1) {
      pick = 0;
    } else if (number == 2) {
      pick = 1;
    } else if (number == 3) {
      pick = 2;
    } else if (number == 4) {
      pick = 3;
    } else {
      pick = wire_pick(rng);
    }
    if (pick == 0) {  // varint
      wire::AppendTag(msg, number, WireType::kVarint);
      wire::AppendVarint(msg, rng());
    } else if (pick == 1) {  // fixed64
      wire::AppendTag(msg, number, WireType::kFixed64);
      for (int b = 0; b < 8; ++b) {
        msg.push_back(static_cast<char>(byte_dist(rng)));
      }
    } else if (pick == 2) {  // length-delimited (incl. nested messages)
      std::string payload(len_dist(rng), '\0');
      for (char& c : payload) c = static_cast<char>(byte_dist(rng));
      wire::AppendTag(msg, number, WireType::kLengthDelimited);
      wire::AppendLengthDelimited(msg, payload);
    } else if (pick == 3) {  // fixed32
      wire::AppendTag(msg, number, WireType::kFixed32);
      for (int b = 0; b < 4; ++b) {
        msg.push_back(static_cast<char>(byte_dist(rng)));
      }
    } else {  // group
      wire::AppendTag(msg, number, WireType::kStartGroup);
      wire::AppendTag(msg, number, WireType::kEndGroup);
    }
  }
  return msg;
}

}  // namespace

int main() {
  std::mt19937_64 rng(0xC0FFEEULL);

  // Descriptor only knows a handful of fields; the rest are unknown.
  MessageDescriptor src;
  src.full_name = "Src";
  src.fields = {
      {1, "v1", ValueKind::kInt64, Label::kRepeated, false, "", false, ""},
      {2, "v2", ValueKind::kFixed64},
      {3, "v3", ValueKind::kString},
      {4, "v4", ValueKind::kFixed32},
  };
  src.extension_ranges = {{50, 100}};

  // Destination renames every known field; unknowns must still survive.
  MessageDescriptor dst;
  dst.full_name = "Dst";
  dst.fields = {
      {10, "v1", ValueKind::kInt64, Label::kRepeated, false, "", false, ""},
      {20, "v2", ValueKind::kFixed64},
      {30, "v3", ValueKind::kString},
      {40, "v4", ValueKind::kFixed32},
  };
  dst.extension_ranges = {{50, 100}};

  MessageMigration spec;
  spec.src = &src;
  spec.dst = &dst;
  spec.mappings = {{1, 10}, {2, 20}, {3, 30}, {4, 40}};

  std::unique_ptr<MigrationPlan> plan;
  if (!MigrationPlan::Build(spec, plan).ok()) {
    std::printf("plan build failed\n");
    return 1;
  }
  std::unique_ptr<MigrationPlan> reverse;
  if (!MigrationPlan::BuildReverse(*plan, reverse).ok()) {
    std::printf("reverse build failed\n");
    return 1;
  }

  for (int iter = 0; iter < 5000; ++iter) {
    std::string input = GenerateMessage(rng);

    std::vector<wire::RawField> parsed;
    if (!wire::ParseMessage(input, parsed).ok()) {
      std::printf("generated unparseable message at iter %d\n", iter);
      return 1;
    }

    std::string forward;
    TransformStats fwd_stats;
    if (!Transform(*plan, input, forward, fwd_stats).ok()) {
      std::printf("forward transform failed at iter %d\n", iter);
      return 1;
    }

    std::string back;
    Status rev_status = Transform(*reverse, forward, back);
    if (!rev_status.ok()) {
      std::printf("reverse transform failed at iter %d: %s\n", iter,
                  rev_status.what().c_str());
      return 1;
    }

    // Unknown/extension fields must come back byte-for-byte. Check every
    // field number outside the known set.
    std::vector<wire::RawField> orig_fields;
    std::vector<wire::RawField> back_fields;
    if (!wire::ParseMessage(input, orig_fields).ok() ||
        !wire::ParseMessage(back, back_fields).ok()) {
      std::printf("reparse failed at iter %d\n", iter);
      return 1;
    }
    for (const auto& f : orig_fields) {
      if (src.FindByNumber(f.number) != nullptr) continue;
      bool found = false;
      for (const auto& g : back_fields) {
        if (g.number == f.number && g.payload == f.payload &&
            g.wire == f.wire) {
          found = true;
          break;
        }
      }
      if (!found) {
        std::printf("unknown field %d lost at iter %d\n", f.number, iter);
        return 1;
      }
    }
  }

  std::printf("fuzz: 5000 iterations OK\n");
  return 0;
}
