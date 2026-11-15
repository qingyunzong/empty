#include "dataeng.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

namespace {

namespace fs = std::filesystem;
using namespace std::chrono_literals;

int g_failures = 0;

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: "         \
                << #condition << "\n";                                       \
      ++g_failures;                                                          \
    }                                                                        \
  } while (false)

template <typename A, typename B>
void check_equal(const A& actual, const B& expected, const char* expression,
                 const char* file, int line) {
  if (!(actual == expected)) {
    std::cerr << file << ":" << line << ": CHECK_EQ failed: " << expression
              << "\n  actual:   " << actual << "\n  expected: " << expected
              << "\n";
    ++g_failures;
  }
}

#define CHECK_EQ(actual, expected) \
  check_equal((actual), (expected), #actual " == " #expected, __FILE__, __LINE__)

std::uint64_t process_id() {
#if defined(_WIN32)
  return static_cast<std::uint64_t>(_getpid());
#else
  return static_cast<std::uint64_t>(getpid());
#endif
}

class TempDir {
 public:
  TempDir() {
    static std::atomic<std::uint64_t> counter{0};
    const auto stamp =
        std::chrono::steady_clock::now().time_since_epoch().count();
    path_ = fs::temp_directory_path() /
            ("dataeng-tests-" + std::to_string(process_id()) + "-" +
             std::to_string(counter.fetch_add(1)) + "-" +
             std::to_string(stamp));
    std::error_code error;
    fs::create_directories(path_, error);
  }
  ~TempDir() {
    std::error_code error;
    fs::remove_all(path_, error);
  }

  const fs::path& path() const { return path_; }

 private:
  fs::path path_;
};

std::string read_file(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(input)),
                     std::istreambuf_iterator<char>());
}

void write_file(const fs::path& path, std::string_view contents) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
}

std::string prefix_of(std::string_view content, std::uint64_t length) {
  return std::string(content.substr(0, static_cast<std::size_t>(length)));
}

std::string digest_of(std::string_view content) {
  return dataeng::sha256_hex(content);
}

struct Fixture {
  std::string content = "0123456789";
  std::string path = "/incoming/report.csv";
  dataeng::Mdtm mtime{1700000000, 0};

  dataeng::ResumeState state(std::uint64_t offset,
                             std::chrono::milliseconds resolution = 1s) const {
    const auto state = dataeng::ResumeState::from_prefix(
        path, content.size(), mtime, resolution, offset,
        digest_of(prefix_of(content, offset)));
    if (!state) {
      std::cerr << "fixture failed to construct state\n";
      std::exit(2);
    }
    return *state;
  }

  dataeng::RemoteObservation observation(
      std::chrono::milliseconds resolution = 1s) const {
    dataeng::RemoteObservation observation;
    observation.path = path;
    observation.size = content.size();
    observation.mtime = mtime;
    observation.mtime_resolution = resolution;
    return observation;
  }
};

void test_sha256() {
  CHECK_EQ(dataeng::sha256_hex(""),
           std::string(dataeng::kSha256Empty));
  CHECK_EQ(dataeng::sha256_hex("abc"),
           std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK_EQ(dataeng::Sha256::hex("abc"), dataeng::sha256_hex("abc"));

  dataeng::Sha256 hasher;
  hasher.update("a");
  hasher.update("bc");
  CHECK_EQ(hasher.hex_digest(), dataeng::sha256_hex("abc"));
  CHECK_EQ(hasher.hex_digest(), dataeng::sha256_hex("abc"));

  std::string million(1000000, 'a');
  CHECK_EQ(dataeng::sha256_hex(million),
           std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));

  dataeng::PrefixDigest prefix;
  prefix.update("01");
  prefix.update("234");
  CHECK_EQ(prefix.size(), std::uint64_t{5});
  CHECK_EQ(prefix.hex_digest(), dataeng::sha256_hex("01234"));
}

void test_mdtm() {
  const auto value = dataeng::parse_mdtm("20240102030405");
  CHECK(value.has_value());
  CHECK_EQ(value->unix_seconds, std::int64_t{1704164645});
  CHECK_EQ(value->milliseconds, std::uint16_t{0});
  CHECK_EQ(dataeng::format_mdtm(*value), std::string("20240102030405"));

  const auto fractional = dataeng::parse_mdtm_reply("213 20240102030405.123");
  CHECK(fractional.has_value());
  CHECK_EQ(fractional->milliseconds, std::uint16_t{123});
  CHECK_EQ(dataeng::format_mdtm(*fractional),
           std::string("20240102030405.123"));

  const auto long_fraction = dataeng::parse_mdtm("20240102030405.1");
  CHECK(long_fraction.has_value());
  CHECK_EQ(long_fraction->milliseconds, std::uint16_t{100});

  const auto leap_day = dataeng::parse_mdtm("20000229123456");
  CHECK(leap_day.has_value());
  CHECK_EQ(leap_day->unix_seconds, std::int64_t{951827696});
  CHECK_EQ(dataeng::format_mdtm(*leap_day), std::string("20000229123456"));

  CHECK_EQ(dataeng::mdtm_resolution("20240102030405").value(), 1000ms);
  CHECK_EQ(dataeng::mdtm_resolution("20240102030405.1").value(), 100ms);
  CHECK_EQ(dataeng::mdtm_resolution("20240102030405.12").value(), 10ms);
  CHECK_EQ(dataeng::mdtm_resolution("20240102030405.123").value(), 1ms);
  CHECK_EQ(dataeng::mdtm_resolution("20240102030405.123456").value(), 1ms);

  CHECK(!dataeng::parse_mdtm("20230229000000").has_value());
  CHECK(!dataeng::parse_mdtm("20241301000000").has_value());
  CHECK(!dataeng::parse_mdtm("20240101240000").has_value());
  CHECK(!dataeng::parse_mdtm("2024010100000x").has_value());
  CHECK(!dataeng::parse_mdtm("20240101000000.").has_value());

  CHECK_EQ(dataeng::parse_size_reply("213 42").value(), std::uint64_t{42});
  CHECK_EQ(dataeng::parse_size_reply(" 42 ").value(), std::uint64_t{42});
  CHECK(!dataeng::parse_size_reply("213 -1").has_value());
  CHECK(!dataeng::parse_size_reply("213 42x").has_value());
}

void test_state_transitions() {
  Fixture fixture;
  auto state = dataeng::ResumeState::fresh(
      fixture.path, fixture.content.size(), fixture.mtime, 1s);
  CHECK(state.valid());
  CHECK_EQ(state.offset, std::uint64_t{0});
  CHECK_EQ(state.prefix_sha256, std::string(dataeng::kSha256Empty));
  CHECK(!state.complete());

  std::string error;
  CHECK(!state.advance(fixture.content.size() + 1,
                       dataeng::sha256_hex("x"), &error));
  CHECK(!error.empty());

  CHECK(state.advance(5, dataeng::sha256_hex("01234"), &error));
  CHECK_EQ(state.offset, std::uint64_t{5});
  CHECK(!state.advance(5, dataeng::sha256_hex("other"), &error));
  CHECK(!state.advance(4, dataeng::sha256_hex("0123"), &error));
  CHECK(state.advance(10, dataeng::sha256_hex(fixture.content), &error));
  CHECK(state.complete());

  auto zero_with_digest = dataeng::ResumeState::from_prefix(
      fixture.path, fixture.content.size(), fixture.mtime, 1s, 0,
      dataeng::sha256_hex("not-empty"), &error);
  CHECK(!zero_with_digest.has_value());
  CHECK(!error.empty());

  auto too_long = dataeng::ResumeState::from_prefix(
      fixture.path, 3, fixture.mtime, 1s, 4, dataeng::sha256_hex("abcd"),
      &error);
  CHECK(!too_long.has_value());
}

void test_state_encoding() {
  Fixture fixture;
  const auto state = fixture.state(7);
  const auto encoded = dataeng::encode_state(state);
  CHECK(encoded.has_value());

  std::string error;
  const auto decoded = dataeng::decode_state(*encoded, &error);
  CHECK(decoded.has_value());
  if (decoded) {
    CHECK_EQ(decoded->path, state.path);
    CHECK_EQ(decoded->size, state.size);
    CHECK_EQ(decoded->offset, state.offset);
    CHECK_EQ(decoded->prefix_sha256, state.prefix_sha256);
    CHECK(decoded->mtime.has_value());
    if (decoded->mtime) {
      CHECK(*decoded->mtime == *state.mtime);
    }
    CHECK_EQ(decoded->mtime_resolution, state.mtime_resolution);
  }

  std::string corrupted = *encoded;
  const auto position = corrupted.find("path=");
  CHECK(position != std::string::npos);
  corrupted[position + 5] = corrupted[position + 5] == '0' ? '1' : '0';
  CHECK(!dataeng::decode_state(corrupted).has_value());

  std::string truncated = *encoded;
  truncated.pop_back();
  CHECK(!dataeng::decode_state(truncated).has_value());

  std::string no_checksum = *encoded;
  no_checksum.resize(no_checksum.rfind("checksum="));
  CHECK(!dataeng::decode_state(no_checksum).has_value());
}

void test_atomic_state_file() {
  TempDir directory;
  Fixture fixture;
  const fs::path state_path = directory.path() / "download.state";
  const auto first = fixture.state(4);
  std::string error;
  CHECK(dataeng::save_state_atomic(state_path, first, &error));
  CHECK(error.empty());

  const auto loaded = dataeng::load_state(state_path, &error);
  CHECK(loaded.has_value());
  if (loaded) {
    CHECK_EQ(loaded->offset, first.offset);
    CHECK_EQ(loaded->prefix_sha256, first.prefix_sha256);
  }

  const auto second = fixture.state(9);
  CHECK(dataeng::save_state_atomic(state_path, second, &error));
  const auto reloaded = dataeng::load_state(state_path, &error);
  CHECK(reloaded.has_value());
  if (reloaded) {
    CHECK_EQ(reloaded->offset, std::uint64_t{9});
  }

  std::size_t entries = 0;
  for (const auto& entry : fs::directory_iterator(directory.path())) {
    (void)entry;
    ++entries;
  }
  CHECK_EQ(entries, std::size_t{1});

  CHECK(!dataeng::load_state(directory.path() / "missing.state", &error)
             .has_value());
}

void test_precise_metadata() {
  Fixture fixture;
  const auto state = fixture.state(5, 1ms);
  auto observation = fixture.observation(1ms);

  const auto decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Same);
  CHECK(decision.same_generation);
  CHECK(decision.can_resume());
  CHECK(decision.metadata_verified);
  CHECK(!decision.prefix_verified);

  dataeng::VerifyOptions force;
  force.require_prefix_proof = true;
  const auto forced = dataeng::verify_resume(state, observation, force);
  CHECK(forced.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(forced.needs_prefix_proof);
  CHECK(forced.has(dataeng::Conflict::PrefixProofMissing));
  CHECK(!forced.can_resume());
}

void test_coarse_timestamp_requires_proof() {
  Fixture fixture;
  const auto state = fixture.state(5, 1s);
  auto observation = fixture.observation(1s);

  const auto unproven = dataeng::verify_resume(state, observation);
  CHECK(unproven.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(!unproven.same_generation);
  CHECK(unproven.needs_prefix_proof);
  CHECK(unproven.has(dataeng::Conflict::MtimeResolutionInsufficient));
  CHECK(unproven.has(dataeng::Conflict::PrefixProofMissing));

  observation.prefix = dataeng::PrefixProof{
      state.offset, digest_of(prefix_of(fixture.content, state.offset))};
  const auto proven = dataeng::verify_resume(state, observation);
  CHECK(proven.verdict == dataeng::GenerationVerdict::Same);
  CHECK(proven.same_generation);
  CHECK(proven.prefix_verified);

  dataeng::VerifyOptions wider;
  wider.mtime_conflict_margin = 2s;
  const auto still_ambiguous =
      dataeng::verify_resume(state, fixture.observation(1ms), wider);
  CHECK(still_ambiguous.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(still_ambiguous.needs_prefix_proof);
}

void test_prefix_digest_mismatch_is_a_conflict() {
  Fixture fixture;
  const auto state = fixture.state(5, 1s);
  auto observation = fixture.observation(1s);
  observation.prefix = dataeng::PrefixProof{state.offset, digest_of("XXXXX")};

  const auto decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Changed);
  CHECK(!decision.same_generation);
  CHECK(decision.has(dataeng::Conflict::PrefixDigestMismatch));
  CHECK(!decision.needs_prefix_proof);
}

void test_metadata_conflicts() {
  Fixture fixture;
  const auto state = fixture.state(5, 1s);
  auto observation = fixture.observation(1s);
  observation.prefix = dataeng::PrefixProof{
      state.offset, digest_of(prefix_of(fixture.content, state.offset))};

  auto changed = observation;
  changed.size = 11;
  auto decision = dataeng::verify_resume(state, changed);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Changed);
  CHECK(decision.has(dataeng::Conflict::SizeMismatch));

  changed = observation;
  changed.path = "/incoming/other.csv";
  decision = dataeng::verify_resume(state, changed);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Changed);
  CHECK(decision.has(dataeng::Conflict::PathMismatch));

  changed = observation;
  changed.mtime = dataeng::Mdtm{1700000001, 0};
  decision = dataeng::verify_resume(state, changed);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Changed);
  CHECK(decision.has(dataeng::Conflict::MtimeMismatch));

  changed = observation;
  changed.mtime.reset();
  decision = dataeng::verify_resume(state, changed);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(decision.has(dataeng::Conflict::MtimeMissing));
  CHECK(!decision.same_generation);

  changed = observation;
  changed.size.reset();
  decision = dataeng::verify_resume(state, changed);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(decision.has(dataeng::Conflict::SizeMissing));
}

void test_prefix_proof_shape() {
  Fixture fixture;
  const auto state = fixture.state(5, 1s);
  auto observation = fixture.observation(1s);

  observation.prefix = dataeng::PrefixProof{4, digest_of("0123")};
  auto decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(decision.has(dataeng::Conflict::PrefixProofLengthMismatch));
  CHECK(decision.needs_prefix_proof);

  observation.prefix = dataeng::PrefixProof{5, "not-a-digest"};
  decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(decision.has(dataeng::Conflict::PrefixProofInvalid));
  CHECK(decision.needs_prefix_proof);
}

void test_invalid_inputs() {
  Fixture fixture;
  const auto state = fixture.state(5, 1s);
  auto observation = fixture.observation(1s);

  dataeng::VerifyOptions options;
  options.mtime_conflict_margin = -1ms;
  auto decision = dataeng::verify_resume(state, observation, options);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Invalid);
  CHECK(decision.has(dataeng::Conflict::InvalidOptions));

  observation.path.clear();
  decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Invalid);
  CHECK(decision.has(dataeng::Conflict::InvalidObservation));

  dataeng::RemoteObservation negative_resolution = fixture.observation(1s);
  negative_resolution.mtime_resolution = -1ms;
  decision = dataeng::verify_resume(state, negative_resolution);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Invalid);
  CHECK(decision.has(dataeng::Conflict::InvalidObservation));
}

void test_zero_offset_needs_no_prefix_proof() {
  Fixture fixture;
  const auto state = fixture.state(0, 1s);
  auto observation = fixture.observation(1s);
  const auto decision = dataeng::verify_resume(state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Same);
  CHECK(decision.can_resume());

  observation.size = 11;
  const auto changed = dataeng::verify_resume(state, observation);
  CHECK(changed.verdict == dataeng::GenerationVerdict::Changed);
}

void test_local_prefix() {
  TempDir directory;
  Fixture fixture;
  const fs::path part = directory.path() / "download.part";
  const auto state = fixture.state(5, 1s);

  write_file(part, prefix_of(fixture.content, 5));
  auto check = dataeng::check_local_prefix(state, part);
  CHECK(check.ok());
  CHECK_EQ(check.actual_sha256, state.prefix_sha256);

  write_file(part, "01X34");
  check = dataeng::check_local_prefix(state, part);
  CHECK(check.status == dataeng::LocalPrefixStatus::DigestMismatch);

  write_file(part, "0123");
  check = dataeng::check_local_prefix(state, part);
  CHECK(check.status == dataeng::LocalPrefixStatus::Short);

  write_file(part, "012345");
  check = dataeng::check_local_prefix(state, part);
  CHECK(check.status == dataeng::LocalPrefixStatus::Longer);

  std::error_code error;
  fs::remove(part, error);
  check = dataeng::check_local_prefix(state, part);
  CHECK(check.status == dataeng::LocalPrefixStatus::Missing);

  const auto empty_state = fixture.state(0, 1s);
  check = dataeng::check_local_prefix(empty_state, part);
  CHECK(check.ok());
  CHECK_EQ(check.local_size, std::uint64_t{0});
}

void test_capture_state_from_local() {
  TempDir directory;
  Fixture fixture;
  const fs::path part = directory.path() / "recover.part";
  std::string error;

  auto recovered = dataeng::capture_state_from_local(
      fixture.path, fixture.content.size(), fixture.mtime, 1s, part, &error);
  CHECK(recovered.has_value());
  if (recovered) {
    CHECK_EQ(recovered->offset, std::uint64_t{0});
    CHECK_EQ(recovered->prefix_sha256, std::string(dataeng::kSha256Empty));
  }

  write_file(part, prefix_of(fixture.content, 6));
  recovered = dataeng::capture_state_from_local(
      fixture.path, fixture.content.size(), fixture.mtime, 1s, part, &error);
  CHECK(recovered.has_value());
  if (recovered) {
    CHECK_EQ(recovered->offset, std::uint64_t{6});
    CHECK_EQ(recovered->prefix_sha256, digest_of("012345"));
  }

  write_file(part, fixture.content + "too long");
  CHECK(!dataeng::capture_state_from_local(
             fixture.path, fixture.content.size(), fixture.mtime, 1s, part,
             &error)
             .has_value());
  CHECK(!error.empty());
}

void test_rename_overwrite_cannot_splice() {
  Fixture fixture;
  const std::string file_a = "AAAAA11111";
  const std::string file_b = "BBBBB22222";
  CHECK_EQ(file_a.size(), file_b.size());

  const auto state = dataeng::ResumeState::from_prefix(
      fixture.path, file_a.size(), fixture.mtime, 1s, 5, digest_of("AAAAA"));
  CHECK(state.has_value());

  auto observation = fixture.observation(1s);
  observation.size = file_a.size();
  observation.prefix =
      dataeng::PrefixProof{5, digest_of(prefix_of(file_a, 5))};
  auto decision = dataeng::verify_resume(*state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Same);

  // B is renamed over the path inside the same MDTM tick: SIZE and MDTM are
  // byte-for-byte identical to A, only the remote prefix digest differs.
  observation.prefix =
      dataeng::PrefixProof{5, digest_of(prefix_of(file_b, 5))};
  decision = dataeng::verify_resume(*state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Changed);
  CHECK(decision.has(dataeng::Conflict::PrefixDigestMismatch));
  CHECK(!decision.can_resume());

  // Without the proof the coarse timestamp cannot prove anything.
  observation.prefix.reset();
  decision = dataeng::verify_resume(*state, observation);
  CHECK(decision.verdict == dataeng::GenerationVerdict::Unproven);
  CHECK(decision.needs_prefix_proof);
  CHECK(!decision.can_resume());
}

void test_completion_and_atomic_commit() {
  TempDir directory;
  Fixture fixture;
  const fs::path part = directory.path() / "collect.part";
  const fs::path final_path = directory.path() / "collect.csv";
  write_file(part, fixture.content);

  const auto state = fixture.state(fixture.content.size(), 1ms);
  auto observation = fixture.observation(1ms);

  auto proof = dataeng::verify_completion(state, observation);
  CHECK(proof.has_value());
  if (proof) {
    write_file(final_path, "old");
    std::string error;
    CHECK(dataeng::commit_completion(std::move(*proof), part, final_path,
                                     &error));
    CHECK(error.empty());
    CHECK_EQ(read_file(final_path), fixture.content);
    CHECK(!fs::exists(part));
  }

  // A corrupted part file cannot be published even after verification.
  write_file(part, fixture.content);
  auto verified = dataeng::verify_completion(state, observation);
  CHECK(verified.has_value());
  if (verified) {
    std::string corrupted = fixture.content;
    corrupted[3] = 'X';
    write_file(part, corrupted);
    std::string error;
    CHECK(!dataeng::commit_completion(std::move(*verified), part, final_path,
                                      &error));
    CHECK(!error.empty());
    CHECK_EQ(read_file(final_path), fixture.content);
  }
}

void test_completion_with_coarse_timestamp() {
  TempDir directory;
  Fixture fixture;
  const fs::path part = directory.path() / "collect.part";
  const fs::path final_path = directory.path() / "collect.csv";
  write_file(part, fixture.content);

  const auto state = fixture.state(fixture.content.size(), 1s);
  auto observation = fixture.observation(1s);
  std::string error;

  CHECK(!dataeng::verify_completion(state, observation, {}, &error)
             .has_value());
  CHECK(!error.empty());

  observation.prefix = dataeng::PrefixProof{
      fixture.content.size(), digest_of(fixture.content)};
  auto proof = dataeng::verify_completion(state, observation, {}, &error);
  CHECK(proof.has_value());
  if (proof) {
    CHECK(dataeng::commit_completion(std::move(*proof), part, final_path,
                                     &error));
    CHECK_EQ(read_file(final_path), fixture.content);
  }

  // A full-file proof for a different file must never produce a token.
  write_file(part, fixture.content);
  observation.prefix =
      dataeng::PrefixProof{fixture.content.size(), digest_of("XXXXXXXXXX")};
  CHECK(!dataeng::verify_completion(state, observation, {}, &error)
             .has_value());
}

void test_spliced_part_cannot_complete() {
  TempDir directory;
  Fixture fixture;
  const std::string file_a = "AAAAA11111";
  const std::string file_b = "BBBBB22222";
  // Simulate the damage caused by appending B's tail to A's prefix.
  const std::string spliced = prefix_of(file_a, 5) + prefix_of(file_b, 10).substr(5);
  const fs::path part = directory.path() / "spliced.part";
  write_file(part, spliced);

  const auto state = dataeng::ResumeState::from_prefix(
      fixture.path, spliced.size(), fixture.mtime, 1s, spliced.size(),
      digest_of(spliced));
  CHECK(state.has_value());

  dataeng::RemoteObservation observation = fixture.observation(1s);
  observation.size = file_b.size();
  observation.prefix =
      dataeng::PrefixProof{file_b.size(), digest_of(file_b)};

  std::string error;
  CHECK(!dataeng::verify_completion(*state, observation, {}, &error)
             .has_value());
  CHECK(!error.empty());
}

void test_incomplete_completion_rejected() {
  Fixture fixture;
  const auto state = fixture.state(5, 1ms);
  std::string error;
  CHECK(!dataeng::verify_completion(state, fixture.observation(1ms), {},
                                    &error)
             .has_value());
  CHECK(!error.empty());
}

void test_empty_completion() {
  TempDir directory;
  const fs::path part = directory.path() / "empty.part";
  const fs::path target = directory.path() / "empty.dat";
  const dataeng::Mdtm mtime{1700000000, 0};
  const auto state = dataeng::ResumeState::fresh("/incoming/empty.dat", 0,
                                                  mtime, 1ms);
  dataeng::RemoteObservation observation;
  observation.path = state.path;
  observation.size = 0;
  observation.mtime = mtime;
  observation.mtime_resolution = 1ms;

  auto proof = dataeng::verify_completion(state, observation);
  CHECK(proof.has_value());
  if (proof) {
    std::string error;
    CHECK(dataeng::commit_completion(std::move(*proof), part, target, &error));
    CHECK(fs::exists(target));
    CHECK_EQ(fs::file_size(target), std::uintmax_t{0});
  }
}

struct TestCase {
  const char* name;
  void (*function)();
};

}  // namespace

int main() {
  const TestCase tests[] = {
      {"sha256", test_sha256},
      {"mdtm", test_mdtm},
      {"state_transitions", test_state_transitions},
      {"state_encoding", test_state_encoding},
      {"atomic_state_file", test_atomic_state_file},
      {"precise_metadata", test_precise_metadata},
      {"coarse_timestamp_requires_proof",
       test_coarse_timestamp_requires_proof},
      {"prefix_digest_mismatch", test_prefix_digest_mismatch_is_a_conflict},
      {"metadata_conflicts", test_metadata_conflicts},
      {"prefix_proof_shape", test_prefix_proof_shape},
      {"invalid_inputs", test_invalid_inputs},
      {"zero_offset", test_zero_offset_needs_no_prefix_proof},
      {"local_prefix", test_local_prefix},
      {"capture_state", test_capture_state_from_local},
      {"rename_overwrite", test_rename_overwrite_cannot_splice},
      {"completion_atomic_commit", test_completion_and_atomic_commit},
      {"completion_coarse", test_completion_with_coarse_timestamp},
      {"spliced_cannot_complete", test_spliced_part_cannot_complete},
      {"incomplete_completion", test_incomplete_completion_rejected},
      {"empty_completion", test_empty_completion},
  };

  for (const auto& test : tests) {
    const int before = g_failures;
    test.function();
    if (g_failures == before) {
      std::cout << "PASS " << test.name << "\n";
    } else {
      std::cout << "FAIL " << test.name << "\n";
    }
  }

  if (g_failures != 0) {
    std::cerr << g_failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all tests passed\n";
  return 0;
}
