#pragma once

// dataeng - embeddable resume-state primitives for FTP downloads.
//
// The library deliberately does not speak FTP.  The embedding service fills a
// RemoteObservation from SIZE, MDTM and (when needed) a REST 0 + RETR read of
// the remote prefix, then asks this library whether appending to an existing
// partial file is safe.
//
// A generation is identified by the tuple
//
//   (remote path, SIZE, MDTM, SHA-256 of the already downloaded prefix)
//
// Metadata equality alone is not enough on FTP servers whose MDTM only has
// whole-second (or coarser) resolution: a rename or overwrite inside one
// timestamp tick is invisible in SIZE/MDTM.  In that case the verifier reports
// Unproven and requires a digest of the remote prefix.  That digest is the
// guard which prevents prefix bytes from file A being followed by tail bytes
// from file B.

#include <array>
#include <chrono>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

// SHA-256("") - the digest of the empty prefix.
inline constexpr std::string_view kSha256Empty =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

// Incremental SHA-256.  Copiable, no allocation and no external dependency.
class Sha256 {
 public:
  Sha256() noexcept;

  void update(const void* data, std::size_t size) noexcept;
  void update(std::string_view data) noexcept { update(data.data(), data.size()); }

  // Returns 64 lowercase hexadecimal characters.  Does not modify the hasher.
  std::string hex_digest() const;

  static std::string hex(std::string_view data) {
    Sha256 hasher;
    hasher.update(data);
    return hasher.hex_digest();
  }

 private:
  void transform(const unsigned char* block) noexcept;

  std::array<std::uint32_t, 8> state_{};
  std::uint64_t bit_count_ = 0;
  std::array<unsigned char, 64> buffer_{};
  std::size_t buffer_size_ = 0;
};

std::string sha256_hex(std::string_view data);

// Returns true for exactly 64 hexadecimal characters (either case).
bool is_sha256_hex(std::string_view text) noexcept;

// Lowercases a valid SHA-256 hex string.  Invalid input is returned unchanged.
std::string normalize_sha256(std::string_view text);

// Hashes `length` bytes from the beginning of `file`.  Fails when the file is
// shorter than requested or cannot be read.  On success the returned digest is
// the digest of the downloaded prefix stored in ResumeState::prefix_sha256.
std::optional<std::string> sha256_file_prefix(const std::filesystem::path& file,
                                              std::uint64_t length,
                                              std::string* error = nullptr);

// SHA-256 plus a byte counter.  A convenient way for a download loop to keep
// the prefix digest current while appending chunks to the local .part file.
class PrefixDigest {
 public:
  void update(const void* data, std::size_t size) noexcept;
  void update(std::string_view data) noexcept { update(data.data(), data.size()); }

  std::uint64_t size() const noexcept { return size_; }
  std::string hex_digest() const { return hash_.hex_digest(); }

 private:
  Sha256 hash_;
  std::uint64_t size_ = 0;
};

// ---------------------------------------------------------------------------
// MDTM
// ---------------------------------------------------------------------------

// An FTP MDTM timestamp normalized to UTC.
struct Mdtm {
  std::int64_t unix_seconds = 0;
  std::uint16_t milliseconds = 0;

  auto operator<=>(const Mdtm&) const = default;
};

// Parses YYYYMMDDHHMMSS[.fraction] in UTC.  A leading "213 " reply code is
// accepted, as are surrounding spaces.  Fractions with one to three digits are
// converted to milliseconds; extra digits are tolerated and truncated.
std::optional<Mdtm> parse_mdtm(std::string_view text);
std::optional<Mdtm> parse_mdtm_reply(std::string_view reply);

// ISO style YYYYMMDDHHMMSS[.mmm].  Returns an empty string when the year falls
// outside 0000..9999.
std::string format_mdtm(const Mdtm& mdtm);

// Resolution implied by the textual MDTM form: no fraction = 1s, one digit =
// 100ms, two = 10ms, three or more = 1ms.  This is a lower bound on what the
// server can distinguish; a server may still be coarser in practice, in which
// case the embedding service should set RemoteObservation::mtime_resolution
// explicitly.
std::optional<std::chrono::milliseconds> mdtm_resolution(std::string_view text);

// Parses a SIZE reply ("213 12345") or a bare decimal size.
std::optional<std::uint64_t> parse_size_reply(std::string_view reply);

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

// Persisted identity of one remote generation plus local progress.
//
// `prefix_sha256` is the SHA-256 of local/remote bytes [0, offset).  It is part
// of the identity, not merely a checksum: two files with equal path, SIZE and
// MDTM but different prefixes are different generations.
struct ResumeState {
  std::string path;
  std::uint64_t size = 0;
  std::optional<Mdtm> mtime;
  std::chrono::milliseconds mtime_resolution{1000};
  std::uint64_t offset = 0;
  std::string prefix_sha256;

  // State for a download that has not read any bytes yet.
  static ResumeState fresh(std::string remote_path,
                           std::uint64_t remote_size,
                           std::optional<Mdtm> remote_mtime,
                           std::chrono::milliseconds remote_mtime_resolution =
                               std::chrono::milliseconds{1000});

  // State captured after `offset` bytes have been read.  Returns nullopt and
  // fills `error` if the combination violates a state invariant.
  static std::optional<ResumeState> from_prefix(
      std::string remote_path,
      std::uint64_t remote_size,
      std::optional<Mdtm> remote_mtime,
      std::chrono::milliseconds remote_mtime_resolution,
      std::uint64_t offset,
      std::string prefix_sha256,
      std::string* error = nullptr);

  // Checks path non-empty, offset <= size, valid digest and offset 0 =>
  // digest of the empty string.
  bool valid(std::string* error = nullptr) const;

  bool complete() const noexcept { return offset == size; }

  // Advances progress after bytes have been appended.  This only validates the
  // state transition; the caller must feed appended bytes to PrefixDigest and
  // pass the resulting digest.  Rewinds, growth past SIZE and overflows are
  // rejected.
  bool advance(std::uint64_t new_offset,
               std::string new_prefix_sha256,
               std::string* error = nullptr);

  bool operator==(const ResumeState&) const = default;
};

// Versioned, checksummed text encoding.  The encoding is deterministic and
// contains no locale-dependent formatting.  decode_state rejects truncation,
// bad checksums and unknown versions.
std::optional<std::string> encode_state(const ResumeState& state);
std::optional<ResumeState> decode_state(std::string_view encoded,
                                        std::string* error = nullptr);

// Writes through a uniquely named temporary file in the target directory and
// renames it over `file`, so readers never observe a partly written state.
bool save_state_atomic(const std::filesystem::path& file,
                       const ResumeState& state,
                       std::string* error = nullptr);
std::optional<ResumeState> load_state(const std::filesystem::path& file,
                                      std::string* error = nullptr);

// Reconstructs a state from an existing .part file after a process restart.
// A missing file yields a fresh offset-0 state.  The file must be regular and
// no longer than `remote_size`; its full current length becomes the offset and
// its SHA-256 becomes the prefix digest.  Generation verification still has to
// be performed with verify_resume() before REST.
std::optional<ResumeState> capture_state_from_local(
    std::string remote_path,
    std::uint64_t remote_size,
    std::optional<Mdtm> remote_mtime,
    std::chrono::milliseconds remote_mtime_resolution,
    const std::filesystem::path& local_part,
    std::string* error = nullptr);

// ---------------------------------------------------------------------------
// Generation verification
// ---------------------------------------------------------------------------

// Digest of the remote prefix [0, length).  length must equal the state offset
// (or the complete file size when finalizing).  Obtain it by issuing REST 0 and
// reading exactly `length` bytes, or from a server-side hash facility.
struct PrefixProof {
  std::uint64_t length = 0;
  std::string sha256_hex;

  bool operator==(const PrefixProof&) const = default;
};

// Facts observed immediately before a REST resume (or before final commit).
struct RemoteObservation {
  std::string path;
  std::optional<std::uint64_t> size;
  std::optional<Mdtm> mtime;

  // Granularity of the MDTM value.  Defaults to 1s because ordinary FTP MDTM
  // has no fractional part.  Use mdtm_resolution() when the reply carries a
  // fraction, or a larger value if the server rounds timestamps.
  std::chrono::milliseconds mtime_resolution{1000};

  // Optional remote-prefix proof.  When MDTM resolution is too coarse this is
  // mandatory before any byte is appended.
  std::optional<PrefixProof> prefix;

  bool operator==(const RemoteObservation&) const = default;
};

struct VerifyOptions {
  // Timestamp resolutions at or below this threshold are treated as precise
  // enough to distinguish a replacement.  The default trusts only millisecond
  // (or finer) MDTM.  Ordinary whole-second MDTM therefore requires a prefix
  // proof.
  std::chrono::milliseconds max_trusted_mtime_resolution{1};

  // Extra uncertainty added to both recorded and observed resolutions.  Raise
  // this to widen the window in which timestamps are considered ambiguous;
  // ambiguous timestamps force prefix proof instead of being accepted.
  std::chrono::milliseconds mtime_conflict_margin{0};

  // Force remote-prefix proof even when metadata is precise.  Use this for
  // remotes that are known to be concurrently rewritten.
  bool require_prefix_proof = false;
};

enum class GenerationVerdict {
  Same,      // the remote is proven to be the state's generation
  Changed,   // the remote is proven to be a different generation
  Unproven,  // not enough evidence to append; fetch a prefix proof or restart
  Invalid,   // invalid state, observation or option
};

enum class Conflict {
  InvalidState,
  InvalidObservation,
  InvalidOptions,
  PathMismatch,
  SizeMissing,
  SizeMismatch,
  MtimeMissing,
  MtimeMismatch,
  MtimeResolutionInsufficient,
  PrefixProofMissing,
  PrefixProofLengthMismatch,
  PrefixProofInvalid,
  PrefixDigestMismatch,
};

std::string_view to_string(GenerationVerdict verdict) noexcept;
std::string_view to_string(Conflict conflict) noexcept;

struct ResumeDecision {
  GenerationVerdict verdict = GenerationVerdict::Invalid;
  std::vector<Conflict> conflicts;
  bool same_generation = false;
  bool metadata_verified = false;
  bool prefix_verified = false;
  bool needs_prefix_proof = false;

  bool can_resume() const noexcept { return same_generation; }
  bool must_restart() const noexcept { return !same_generation; }
  bool has(Conflict conflict) const noexcept;

  // Human-readable, deterministic summary suitable for logs.
  std::string explain() const;
};

// Verifies that the remote still belongs to the generation described by
// `state`, and that appending bytes from `state.offset` cannot splice two
// different files.
//
// Order of evidence:
//   1. path, SIZE and MDTM must match exactly;
//   2. a supplied remote prefix digest must match the saved prefix digest;
//   3. if the effective MDTM resolution is coarser than
//      max_trusted_mtime_resolution (or require_prefix_proof is set), a
//      matching remote prefix proof is mandatory.
//
// A path/SIZE/MDTM difference is always a conflict, even if the prefix still
// matches, because the unchanged prefix cannot prove anything about the tail.
// At offset 0 there is no existing prefix to splice, so matching metadata is
// enough to start a fresh download of whatever currently lives at the path.
ResumeDecision verify_resume(const ResumeState& state,
                             const RemoteObservation& remote,
                             const VerifyOptions& options = {});

// ---------------------------------------------------------------------------
// Local partial-file checks
// ---------------------------------------------------------------------------

enum class LocalPrefixStatus {
  Ok,
  InvalidState,
  Missing,
  NotRegular,
  Short,
  Longer,
  IoError,
  DigestMismatch,
};

std::string_view to_string(LocalPrefixStatus status) noexcept;

struct LocalPrefixCheck {
  LocalPrefixStatus status = LocalPrefixStatus::InvalidState;
  std::uint64_t local_size = 0;
  std::string actual_sha256;
  std::string detail;

  bool ok() const noexcept { return status == LocalPrefixStatus::Ok; }
};

// Verifies that the local .part file is exactly `state.offset` bytes long and
// that its prefix digest matches the state.  Never append to a file that fails
// this check; discard it and restart instead.
LocalPrefixCheck check_local_prefix(const ResumeState& state,
                                    const std::filesystem::path& local_part);

// ---------------------------------------------------------------------------
// Completion and atomic publication
// ---------------------------------------------------------------------------

// Opaque token produced only by a successful verify_completion().  Holding one
// means the remote generation was verified while the state was complete.
class CompletionProof {
 public:
  CompletionProof(CompletionProof&&) noexcept = default;
  CompletionProof& operator=(CompletionProof&&) noexcept = default;
  CompletionProof(const CompletionProof&) = delete;
  CompletionProof& operator=(const CompletionProof&) = delete;

  const ResumeState& state() const noexcept { return state_; }

 private:
  friend std::optional<CompletionProof> verify_completion(
      const ResumeState&,
      const RemoteObservation&,
      const VerifyOptions&,
      std::string*);

  explicit CompletionProof(ResumeState state) : state_(std::move(state)) {}
  ResumeState state_;
};

// Verifies a fully downloaded state (offset == size).  The same evidence rules
// as verify_resume apply.  For a concurrently rewritten remote, pass
// VerifyOptions::require_prefix_proof = true and a remote proof whose length is
// the full file size; that proves the remote bytes equal the local digest.
std::optional<CompletionProof> verify_completion(
    const ResumeState& state,
    const RemoteObservation& remote,
    const VerifyOptions& options = {},
    std::string* error = nullptr);

// Re-hashes the .part file, requires exact size and digest, fsyncs it on
// POSIX, then atomically renames it to `target`.  A concurrent local writer or
// corruption after verify_completion() is therefore rejected instead of being
// published as a successful collection.
bool commit_completion(CompletionProof proof,
                       const std::filesystem::path& local_part,
                       const std::filesystem::path& target,
                       std::string* error = nullptr);

}  // namespace dataeng
