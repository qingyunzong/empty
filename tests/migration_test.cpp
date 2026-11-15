#include "dataeng/dataeng.hpp"

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace {

using namespace dataeng;
using dataeng::wire::WireType;

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    ++g_checks;                                                           \
    if (!(cond)) {                                                        \
      ++g_failures;                                                       \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);         \
    }                                                                     \
  } while (0)

#define CHECK_EQ(a, b)                                                    \
  do {                                                                    \
    ++g_checks;                                                           \
    auto va_ = (a);                                                       \
    auto vb_ = (b);                                                       \
    if (!(va_ == vb_)) {                                                  \
      ++g_failures;                                                       \
      std::printf("FAIL %s:%d  %s != %s\n", __FILE__, __LINE__, #a, #b); \
    }                                                                     \
  } while (0)

std::string VarintField(int number, uint64_t value) {
  std::string out;
  wire::AppendTag(out, number, WireType::kVarint);
  wire::AppendVarint(out, value);
  return out;
}

std::string Fixed32Field(int number, uint32_t value) {
  std::string out;
  wire::AppendTag(out, number, WireType::kFixed32);
  for (int i = 0; i < 4; ++i) {
    out.push_back(static_cast<char>((value >> (8 * i)) & 0xFF));
  }
  return out;
}

std::string Fixed64Field(int number, uint64_t value) {
  std::string out;
  wire::AppendTag(out, number, WireType::kFixed64);
  for (int i = 0; i < 8; ++i) {
    out.push_back(static_cast<char>((value >> (8 * i)) & 0xFF));
  }
  return out;
}

std::string LdField(int number, std::string_view payload) {
  std::string out;
  wire::AppendTag(out, number, WireType::kLengthDelimited);
  wire::AppendLengthDelimited(out, payload);
  return out;
}

std::string StringField(int number, std::string_view value) {
  return LdField(number, value);
}

FieldDescriptor F(int number, std::string name, ValueKind kind,
                  Label label = Label::kOptional,
                  std::string oneof = {}, bool extension = false,
                  bool packed = false, std::string type_name = {}) {
  FieldDescriptor field;
  field.number = number;
  field.name = std::move(name);
  field.kind = kind;
  field.label = label;
  field.oneof_name = std::move(oneof);
  field.extension = extension;
  field.packed = packed;
  field.type_name = std::move(type_name);
  return field;
}

bool HasCode(const MigrationReport& report, std::string_view code) {
  for (const Change& change : report.changes()) {
    if (change.code == code) return true;
  }
  return false;
}

bool IsIrreversibleCode(const MigrationReport& report,
                        std::string_view code) {
  for (const Change& change : report.changes()) {
    if (change.code == code) {
      return change.severity == Severity::kIrreversible;
    }
  }
  return false;
}

void TestVarintRoundTripEncoding() {
  for (uint64_t v : {uint64_t{0}, uint64_t{1}, uint64_t{127},
                     uint64_t{128}, uint64_t{16383}, uint64_t{1ULL << 32},
                     uint64_t{~0ULL}}) {
    std::string bytes;
    CHECK(wire::AppendVarint(bytes, v).ok());
    size_t cursor = 0;
    uint64_t decoded = 0;
    CHECK(wire::ReadVarint(bytes, cursor, decoded).ok());
    CHECK_EQ(decoded, v);
    CHECK_EQ(cursor, bytes.size());
  }
}

void TestMalformedWireRejected() {
  std::vector<wire::RawField> fields;
  CHECK(!wire::ParseMessage(std::string("\x08\x80", 2), fields).ok());
  CHECK(!wire::ParseMessage(std::string("\x12\x05" "abc", 5), fields).ok());
  CHECK(!wire::ParseMessage(std::string("\x00", 1), fields).ok());
  CHECK(!wire::ParseMessage(std::string("\x0d\x01\x02", 3), fields).ok());
}

void TestRenameAndPassthrough() {
  MessageDescriptor old_desc{
      "Old",
      {F(1, "id", ValueKind::kInt64), F(2, "name", ValueKind::kString)}};
  MessageDescriptor new_desc{
      "New",
      {F(1, "id", ValueKind::kInt64), F(3, "label", ValueKind::kString)}};

  MessageMigration spec;
  spec.src = &old_desc;
  spec.dst = &new_desc;
  spec.mappings = {{2, 3}};

  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());

  std::string input = VarintField(1, 42) + StringField(2, "hello");
  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, VarintField(1, 42) + StringField(3, "hello"));
  CHECK_EQ(stats.mapped_fields, size_t(2));
  CHECK(HasCode(plan->report(), "FIELD_RENAMED"));
}

void TestUnknownFieldsPreservedByteForByte() {
  MessageDescriptor old_desc{"Old", {F(1, "id", ValueKind::kInt64)}};
  MessageDescriptor new_desc{"New", {F(1, "id", ValueKind::kInt64)}};

  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());

  std::string unknown_a = VarintField(99, 777);
  std::string unknown_b = StringField(7, std::string("\x00\x01\xfe", 3));
  std::string unknown_c = Fixed64Field(100, 0xDEADBEEFCAFEULL);
  std::string input =
      VarintField(1, 5) + unknown_a + unknown_b + unknown_c;

  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, input);
  CHECK_EQ(stats.unknown_fields_preserved, size_t(3));

  RoundTripResult rt;
  CHECK(VerifyRoundTrip(*plan, input, rt).ok());
  CHECK(rt.equivalent);
  CHECK(rt.diverged_unknown_numbers.empty());
}

void TestFieldNumberReuseRejected() {
  MessageDescriptor old_desc{
      "Old", {F(1, "a", ValueKind::kInt32), F(2, "b", ValueKind::kString)}};
  MessageDescriptor new_desc{
      "New", {F(1, "a", ValueKind::kInt32), F(2, "b", ValueKind::kInt32)}};

  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  Status s = MigrationPlan::Build(spec, plan);
  CHECK(!s.ok());
  CHECK_EQ(s.code, StatusCode::kWireTypeConflict);
}

void TestTwoSourcesSameDestinationRejected() {
  MessageDescriptor old_desc{
      "Old", {F(1, "a", ValueKind::kInt32), F(2, "b", ValueKind::kInt32)}};
  MessageDescriptor new_desc{
      "New", {F(1, "a", ValueKind::kInt32), F(3, "c", ValueKind::kInt32)}};
  MessageMigration spec{&old_desc, &new_desc, {{1, 3}, {2, 3}}, true};
  std::unique_ptr<MigrationPlan> plan;
  Status s = MigrationPlan::Build(spec, plan);
  CHECK(!s.ok());
  CHECK_EQ(s.code, StatusCode::kFieldNumberReuse);
}

void TestReservedNumberRejected() {
  MessageDescriptor old_desc{"Old", {F(5, "x", ValueKind::kInt32)}};
  MessageDescriptor new_desc;
  new_desc.full_name = "New";
  new_desc.fields = {F(5, "y", ValueKind::kInt32)};
  new_desc.reserved_numbers = {5};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  Status s = MigrationPlan::Build(spec, plan);
  CHECK(!s.ok());
  CHECK_EQ(s.code, StatusCode::kFieldNumberReuse);
}

void TestOneofSelectionPreservedAndCollisionsReported() {
  MessageDescriptor old_desc;
  old_desc.full_name = "Old";
  old_desc.fields = {
      F(1, "choice_a", ValueKind::kInt32, Label::kOptional, "pick"),
      F(2, "choice_b", ValueKind::kString, Label::kOptional, "pick")};
  old_desc.oneofs = {{"pick"}};

  MessageDescriptor new_desc;
  new_desc.full_name = "New";
  new_desc.fields = {
      F(10, "choice_a", ValueKind::kInt32, Label::kOptional, "pick2"),
      F(20, "choice_b", ValueKind::kString, Label::kOptional, "pick2")};
  new_desc.oneofs = {{"pick2"}};

  MessageMigration spec;
  spec.src = &old_desc;
  spec.dst = &new_desc;
  spec.mappings = {{1, 10}, {2, 20}};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());

  std::string one_member = VarintField(1, 9);
  std::string out;
  TransformStats stats;
  CHECK(Transform(*plan, one_member, out, stats).ok());
  CHECK_EQ(out, VarintField(10, 9));
  CHECK_EQ(stats.oneof_collisions, size_t(0));

  std::string both = VarintField(1, 9) + StringField(2, "z");
  CHECK(Transform(*plan, both, out, stats).ok());
  CHECK_EQ(stats.oneof_collisions, size_t(1));
  CHECK(IsIrreversibleCode(plan->report(), "ONEOF_RUNTIME_COLLISION"));
}

void TestOneofMergeFlaggedAtBuildTime() {
  MessageDescriptor old_desc;
  old_desc.full_name = "Old";
  old_desc.fields = {
      F(1, "a", ValueKind::kInt32, Label::kOptional, "oa"),
      F(2, "b", ValueKind::kInt32, Label::kOptional, "ob")};
  old_desc.oneofs = {{"oa"}, {"ob"}};

  MessageDescriptor new_desc;
  new_desc.full_name = "New";
  new_desc.fields = {
      F(1, "a", ValueKind::kInt32, Label::kOptional, "merged"),
      F(2, "b", ValueKind::kInt32, Label::kOptional, "merged")};
  new_desc.oneofs = {{"merged"}};

  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(IsIrreversibleCode(plan->report(), "ONEOF_MERGE"));
}

void TestPresenceSemanticsReported() {
  MessageDescriptor old_desc{
      "Old", {F(1, "flag", ValueKind::kInt32, Label::kOptional)}};
  MessageDescriptor new_desc{
      "New", {F(1, "flag", ValueKind::kInt32, Label::kSingular)}};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(IsIrreversibleCode(plan->report(), "PRESENCE_LOST"));

  std::string input = VarintField(1, 0);
  std::string output;
  CHECK(Transform(*plan, input, output).ok());
  CHECK_EQ(output, input);
}

void TestExtensionFieldsSurvive() {
  MessageDescriptor old_desc;
  old_desc.full_name = "Old";
  old_desc.fields = {
      F(1, "id", ValueKind::kInt32),
      F(1000, "ext_vendor", ValueKind::kString, Label::kOptional, "",
        true)};
  old_desc.extension_ranges = {{1000, 2000}};

  MessageDescriptor new_desc;
  new_desc.full_name = "New";
  new_desc.fields = {F(1, "id", ValueKind::kInt32)};
  new_desc.extension_ranges = {{1000, 2000}};

  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());

  std::string ext_bytes = StringField(1000, "vendor-data");
  std::string input = VarintField(1, 11) + ext_bytes;
  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, input);

  RoundTripResult rt;
  CHECK(VerifyRoundTrip(*plan, input, rt).ok());
  CHECK(rt.equivalent);
}

void TestRemovedFieldBecomesUnknownAndRoundTrips() {
  MessageDescriptor old_desc{
      "Old", {F(1, "keep", ValueKind::kInt32), F(2, "gone", ValueKind::kString)}};
  MessageDescriptor new_desc{"New", {F(1, "keep", ValueKind::kInt32)}};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(HasCode(plan->report(), "FIELD_REMOVED"));

  std::string input = VarintField(1, 7) + StringField(2, "data");
  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, input);  // removed field retained verbatim as unknown

  RoundTripResult rt;
  CHECK(VerifyRoundTrip(*plan, input, rt).ok());
  CHECK(rt.equivalent);
}

void TestRepeatedAndPackedReversibility() {
  MessageDescriptor old_desc;
  old_desc.full_name = "Old";
  old_desc.fields = {F(1, "tags", ValueKind::kInt32, Label::kRepeated, "",
                       false, true)};
  MessageDescriptor new_desc;
  new_desc.full_name = "New";
  new_desc.fields = {F(1, "tags", ValueKind::kInt64, Label::kRepeated, "",
                       false, false)};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(HasCode(plan->report(), "PACKED_CHANGED"));

  // Both packed and unpacked encodings must pass through untouched.
  std::string packed_payload = std::string();
  wire::AppendVarint(packed_payload, 3);
  wire::AppendVarint(packed_payload, 257);
  std::string input = LdField(1, packed_payload) + VarintField(1, 9);
  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, input);

  RoundTripResult rt;
  CHECK(VerifyRoundTrip(*plan, input, rt).ok());
  CHECK(rt.equivalent);
}

void TestNestedMessageTransform() {
  MessageDescriptor old_inner{"OldInner",
                               {F(1, "x", ValueKind::kInt32)}};
  MessageDescriptor new_inner{"NewInner",
                               {F(2, "x", ValueKind::kInt32)}};
  MessageMigration inner_spec{&old_inner, &new_inner, {{1, 2}}, true};
  std::unique_ptr<MigrationPlan> inner_plan;
  CHECK(MigrationPlan::Build(inner_spec, inner_plan).ok());

  MessageDescriptor old_outer{
      "OldOuter",
      {F(1, "inner", ValueKind::kMessage, Label::kOptional, "", false, false,
        "NewInner")}};
  MessageDescriptor new_outer{
      "NewOuter",
      {F(1, "inner", ValueKind::kMessage, Label::kOptional, "", false, false,
        "NewInner")}};
  MessageMigration outer_spec{&old_outer, &new_outer, {}, true};
  std::unique_ptr<MigrationPlan> outer_plan;
  CHECK(MigrationPlan::Build(outer_spec, outer_plan).ok());
  outer_plan->AddNested("NewInner", inner_plan.get());

  std::string inner_bytes = VarintField(1, 123);
  std::string input = LdField(1, inner_bytes);
  std::string output;
  TransformStats stats;
  CHECK(Transform(*outer_plan, input, output, stats).ok());
  CHECK_EQ(output, LdField(1, VarintField(2, 123)));
  CHECK_EQ(stats.nested_messages, size_t(1));
}

void TestRetypingSameWireTypeIsIrreversible() {
  MessageDescriptor old_desc{
      "Old", {F(1, "n", ValueKind::kInt32)}};
  MessageDescriptor new_desc{
      "New", {F(1, "n", ValueKind::kUint32)}};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());  // same varint wire type
  CHECK(IsIrreversibleCode(plan->report(), "KIND_CHANGED"));
}

void TestRequiredDestinationUnsatisfiedReported() {
  MessageDescriptor old_desc{"Old", {F(1, "a", ValueKind::kInt32)}};
  MessageDescriptor new_desc{
      "New", {F(1, "a", ValueKind::kInt32),
              F(2, "b", ValueKind::kInt32, Label::kRequired)}};
  MessageMigration spec{&old_desc, &new_desc, {}, true};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(IsIrreversibleCode(plan->report(),
                           "REQUIRED_FIELD_UNSATISFIED"));
}

void TestRoundTripEquivalenceWithUnknownBytes() {
  MessageDescriptor old_desc{
      "Old", {F(1, "a", ValueKind::kInt32), F(2, "b", ValueKind::kString)}};
  MessageDescriptor new_desc{
      "New", {F(10, "a", ValueKind::kInt32),
              F(20, "b", ValueKind::kString)}};
  MessageMigration spec;
  spec.src = &old_desc;
  spec.dst = &new_desc;
  spec.mappings = {{1, 10}, {2, 20}};
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());

  std::string input = VarintField(1, 42) + StringField(2, "ok") +
                      Fixed32Field(77, 0xCAFEBABE) +
                      VarintField(78, 0xFFFFFFFFFFULL);
  RoundTripResult rt;
  CHECK(VerifyRoundTrip(*plan, input, rt).ok());
  CHECK(rt.equivalent);
  CHECK(rt.diverged_unknown_numbers.empty());
  CHECK(rt.diverged_mapped_numbers.empty());

  // Sanity: the intermediate message really carries the new numbers.
  std::string middle;
  CHECK(Transform(*plan, input, middle).ok());
  std::vector<wire::RawField> parsed;
  CHECK(wire::ParseMessage(middle, parsed).ok());
  std::vector<int> numbers;
  for (const auto& f : parsed) numbers.push_back(f.number);
  std::vector<int> expected = {10, 20, 77, 78};
  CHECK(numbers == expected);
}

void TestGroupFieldRoundTrips() {
  // Group: SGROUP body EGROUP, body containing a varint field.
  std::string group;
  wire::AppendTag(group, 5, WireType::kStartGroup);
  group += VarintField(1, 17);
  wire::AppendTag(group, 5, WireType::kEndGroup);

  std::vector<wire::RawField> parsed;
  CHECK(wire::ParseMessage(group, parsed).ok());
  CHECK_EQ(parsed.size(), size_t(1));
  CHECK_EQ(parsed[0].number, 5);
  CHECK(parsed[0].wire == WireType::kStartGroup);

  std::string re_emitted;
  wire::EmitField(re_emitted, parsed[0], 6);
  std::string expected;
  wire::AppendTag(expected, 6, WireType::kStartGroup);
  expected += VarintField(1, 17);
  wire::AppendTag(expected, 6, WireType::kEndGroup);
  CHECK_EQ(re_emitted, expected);
}

void TestExplicitDropIsIrreversible() {
  MessageDescriptor old_desc{
      "Old", {F(1, "keep", ValueKind::kInt32),
              F(2, "secret", ValueKind::kString)}};
  MessageDescriptor new_desc{"New", {F(1, "keep", ValueKind::kInt32)}};
  MessageMigration spec;
  spec.src = &old_desc;
  spec.dst = &new_desc;
  spec.mappings = {{2, 0, true}};  // explicit drop
  std::unique_ptr<MigrationPlan> plan;
  CHECK(MigrationPlan::Build(spec, plan).ok());
  CHECK(IsIrreversibleCode(plan->report(), "FIELD_DROPPED"));

  std::string input = VarintField(1, 3) + StringField(2, "classified");
  std::string output;
  TransformStats stats;
  CHECK(Transform(*plan, input, output, stats).ok());
  CHECK_EQ(output, VarintField(1, 3));
  CHECK_EQ(stats.dropped_fields, size_t(1));
}

}  // namespace

int main() {
  TestVarintRoundTripEncoding();
  TestMalformedWireRejected();
  TestRenameAndPassthrough();
  TestUnknownFieldsPreservedByteForByte();
  TestFieldNumberReuseRejected();
  TestTwoSourcesSameDestinationRejected();
  TestReservedNumberRejected();
  TestOneofSelectionPreservedAndCollisionsReported();
  TestOneofMergeFlaggedAtBuildTime();
  TestPresenceSemanticsReported();
  TestExtensionFieldsSurvive();
  TestRemovedFieldBecomesUnknownAndRoundTrips();
  TestRepeatedAndPackedReversibility();
  TestNestedMessageTransform();
  TestRetypingSameWireTypeIsIrreversible();
  TestRequiredDestinationUnsatisfiedReported();
  TestRoundTripEquivalenceWithUnknownBytes();
  TestGroupFieldRoundTrips();
  TestExplicitDropIsIrreversible();

  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
