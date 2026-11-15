#include "dataeng.hpp"

#include <atomic>
#include <cstring>
#include <fstream>
#include <memory>
#include <queue>
#include <stdexcept>
#include <thread>

namespace dataeng {

namespace {

std::uint64_t rotl64(std::uint64_t x, int r) {
  return (x << r) | (x >> (64 - r));
}

std::uint64_t fmix64(std::uint64_t k) {
  k ^= k >> 33;
  k *= 0xff51afd7ed558ccdULL;
  k ^= k >> 33;
  k *= 0xc4ceb9fe1a85ec53ULL;
  k ^= k >> 33;
  return k;
}

std::uint64_t get_block(const unsigned char* p, std::size_t i) {
  std::uint64_t v;
  std::memcpy(&v, p + i * 8, 8);
  return v;
}

}  // namespace

Digest StrongHasher::operator()(const Row& row) const {
  // MurmurHash3 x64 128-bit, seed 0.
  const auto* data = reinterpret_cast<const unsigned char*>(row.data());
  const std::size_t len = row.size();
  const std::size_t nblocks = len / 16;

  std::uint64_t h1 = 0;
  std::uint64_t h2 = 0;
  const std::uint64_t c1 = 0x87c37b91114253d5ULL;
  const std::uint64_t c2 = 0x4cf5ad432745937fULL;

  for (std::size_t i = 0; i < nblocks; ++i) {
    std::uint64_t k1 = get_block(data, i * 2);
    std::uint64_t k2 = get_block(data, i * 2 + 1);

    k1 *= c1;
    k1 = rotl64(k1, 31);
    k1 *= c2;
    h1 ^= k1;
    h1 = rotl64(h1, 27);
    h1 += h2;
    h1 = h1 * 5 + 0x52dce729;

    k2 *= c2;
    k2 = rotl64(k2, 33);
    k2 *= c1;
    h2 ^= k2;
    h2 = rotl64(h2, 31);
    h2 += h1;
    h2 = h2 * 5 + 0x38495ab5;
  }

  const unsigned char* tail = data + nblocks * 16;
  std::uint64_t k1 = 0;
  std::uint64_t k2 = 0;
  switch (len & 15) {
    case 15: k2 ^= std::uint64_t(tail[14]) << 48; [[fallthrough]];
    case 14: k2 ^= std::uint64_t(tail[13]) << 40; [[fallthrough]];
    case 13: k2 ^= std::uint64_t(tail[12]) << 32; [[fallthrough]];
    case 12: k2 ^= std::uint64_t(tail[11]) << 24; [[fallthrough]];
    case 11: k2 ^= std::uint64_t(tail[10]) << 16; [[fallthrough]];
    case 10: k2 ^= std::uint64_t(tail[9]) << 8; [[fallthrough]];
    case 9:
      k2 ^= std::uint64_t(tail[8]);
      k2 *= c2;
      k2 = rotl64(k2, 33);
      k2 *= c1;
      h2 ^= k2;
      [[fallthrough]];
    case 8: k1 ^= std::uint64_t(tail[7]) << 56; [[fallthrough]];
    case 7: k1 ^= std::uint64_t(tail[6]) << 48; [[fallthrough]];
    case 6: k1 ^= std::uint64_t(tail[5]) << 40; [[fallthrough]];
    case 5: k1 ^= std::uint64_t(tail[4]) << 32; [[fallthrough]];
    case 4: k1 ^= std::uint64_t(tail[3]) << 24; [[fallthrough]];
    case 3: k1 ^= std::uint64_t(tail[2]) << 16; [[fallthrough]];
    case 2: k1 ^= std::uint64_t(tail[1]) << 8; [[fallthrough]];
    case 1:
      k1 ^= std::uint64_t(tail[0]);
      k1 *= c1;
      k1 = rotl64(k1, 31);
      k1 *= c2;
      h1 ^= k1;
  }

  h1 ^= len;
  h2 ^= len;
  h1 += h2;
  h2 += h1;
  h1 = fmix64(h1);
  h2 = fmix64(h2);
  h1 += h2;
  h2 += h1;
  return Digest{h1, h2};
}

namespace detail {

namespace {

constexpr char kRunMagic[8] = {'D', 'E', 'R', 'U', 'N', '0', '0', '1'};

void write_u64(std::ostream& out, std::uint64_t v) {
  out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

void write_u32(std::ostream& out, std::uint32_t v) {
  out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

bool read_u64(std::istream& in, std::uint64_t& v) {
  return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
}

bool read_u32(std::istream& in, std::uint32_t& v) {
  return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
}

}  // namespace

struct RunWriter::Impl {
  std::ofstream out;
};

RunWriter::RunWriter(const std::filesystem::path& path) : impl_(new Impl) {
  impl_->out.open(path, std::ios::binary | std::ios::trunc);
  if (!impl_->out) {
    throw std::runtime_error("dataeng: cannot open run file for write: " +
                             path.string());
  }
  impl_->out.write(kRunMagic, sizeof(kRunMagic));
}

RunWriter::~RunWriter() { delete impl_; }

void RunWriter::write(const Digest& digest, const Row& row) {
  if (row.size() > 0xFFFFFFFFull) {
    throw std::length_error("dataeng: row too large for run file");
  }
  write_u64(impl_->out, digest.hi);
  write_u64(impl_->out, digest.lo);
  write_u32(impl_->out, static_cast<std::uint32_t>(row.size()));
  impl_->out.write(row.data(), static_cast<std::streamsize>(row.size()));
  if (!impl_->out) {
    throw std::runtime_error("dataeng: failed writing run file");
  }
}

void RunWriter::close() { impl_->out.flush(); }

struct RunReader::Impl {
  std::ifstream in;
};

RunReader::RunReader(const std::filesystem::path& path) : impl_(new Impl) {
  impl_->in.open(path, std::ios::binary);
  if (!impl_->in) {
    throw std::runtime_error("dataeng: cannot open run file for read: " +
                             path.string());
  }
  char magic[sizeof(kRunMagic)];
  if (!impl_->in.read(magic, sizeof(magic)) ||
      std::memcmp(magic, kRunMagic, sizeof(magic)) != 0) {
    throw std::runtime_error("dataeng: bad run file header: " +
                             path.string());
  }
}

RunReader::~RunReader() { delete impl_; }

bool RunReader::next(Digest& digest, Row& row) {
  std::uint64_t hi, lo;
  std::uint32_t len;
  if (!read_u64(impl_->in, hi)) return false;
  if (!read_u64(impl_->in, lo) || !read_u32(impl_->in, len)) {
    throw std::runtime_error("dataeng: truncated run file");
  }
  row.resize(len);
  if (len > 0 && !impl_->in.read(row.data(), len)) {
    throw std::runtime_error("dataeng: truncated run file");
  }
  digest = Digest{hi, lo};
  return true;
}

std::filesystem::path make_temp_run_path(const std::filesystem::path& dir) {
  static std::atomic<std::uint64_t> counter{0};
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  if (ec) {
    throw std::runtime_error("dataeng: cannot create spill dir: " +
                             dir.string());
  }
  for (;;) {
    auto id = counter.fetch_add(1, std::memory_order_relaxed);
    auto path = dir / ("dataeng_run_" + std::to_string(id) + "_" +
                       std::to_string(
                           std::hash<std::thread::id>{}(
                               std::this_thread::get_id())) +
                       ".bin");
    if (!std::filesystem::exists(path)) return path;
  }
}

namespace {

struct MergeItem {
  Digest digest;
  Row row;
  std::size_t source;
};

struct MergeItemGreater {
  bool operator()(const MergeItem& a, const MergeItem& b) const {
    return compare_keys(a.digest, a.row, b.digest, b.row) > 0;
  }
};

using MergeQueue =
    std::priority_queue<MergeItem, std::vector<MergeItem>, MergeItemGreater>;

// Merges `inputs` into one sorted run file at `output`.
void merge_runs_to_file(const std::vector<std::filesystem::path>& inputs,
                        const std::filesystem::path& output) {
  std::vector<std::unique_ptr<RunReader>> readers;
  readers.reserve(inputs.size());
  MergeQueue queue;
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    readers.push_back(std::make_unique<RunReader>(inputs[i]));
    Digest digest;
    Row row;
    if (readers.back()->next(digest, row)) {
      queue.push(MergeItem{digest, std::move(row), i});
    }
  }
  RunWriter writer(output);
  while (!queue.empty()) {
    MergeItem item = std::move(const_cast<MergeItem&>(queue.top()));
    queue.pop();
    writer.write(item.digest, item.row);
    Digest digest;
    Row row;
    if (readers[item.source]->next(digest, row)) {
      queue.push(MergeItem{digest, std::move(row), item.source});
    }
  }
  writer.close();
}

}  // namespace

void reduce_runs(std::vector<std::filesystem::path>& runs,
                 std::size_t fan_in, const std::filesystem::path& dir) {
  if (fan_in < 2) fan_in = 2;
  while (runs.size() > fan_in) {
    std::vector<std::filesystem::path> next_round;
    for (std::size_t i = 0; i < runs.size(); i += fan_in) {
      std::vector<std::filesystem::path> group(
          runs.begin() + static_cast<std::ptrdiff_t>(i),
          runs.begin() +
              static_cast<std::ptrdiff_t>(std::min(i + fan_in, runs.size())));
      if (group.size() == 1) {
        next_round.push_back(group.front());
        continue;
      }
      auto merged = make_temp_run_path(dir);
      merge_runs_to_file(group, merged);
      for (const auto& path : group) {
        std::error_code ec;
        std::filesystem::remove(path, ec);
      }
      next_round.push_back(std::move(merged));
    }
    runs = std::move(next_round);
  }
}

struct MergedRunReader::Impl {
  std::vector<std::unique_ptr<RunReader>> readers;
  MergeQueue queue;
  std::vector<std::filesystem::path> paths;
};

MergedRunReader::MergedRunReader(std::vector<std::filesystem::path> runs)
    : impl_(new Impl) {
  impl_->paths = runs;
  impl_->readers.reserve(runs.size());
  for (std::size_t i = 0; i < runs.size(); ++i) {
    impl_->readers.push_back(std::make_unique<RunReader>(runs[i]));
    Digest digest;
    Row row;
    if (impl_->readers.back()->next(digest, row)) {
      impl_->queue.push(MergeItem{digest, std::move(row), i});
    }
  }
}

MergedRunReader::~MergedRunReader() {
  auto paths = std::move(impl_->paths);
  delete impl_;
  for (const auto& path : paths) {
    std::error_code ec;
    std::filesystem::remove(path, ec);
  }
}

bool MergedRunReader::next(Digest& digest, Row& row) {
  if (impl_->queue.empty()) return false;
  MergeItem item = std::move(const_cast<MergeItem&>(impl_->queue.top()));
  impl_->queue.pop();
  digest = item.digest;
  row = std::move(item.row);
  Digest next_digest;
  Row next_row;
  if (impl_->readers[item.source]->next(next_digest, next_row)) {
    impl_->queue.push(
        MergeItem{next_digest, std::move(next_row), item.source});
  }
  return true;
}

}  // namespace detail

}  // namespace dataeng
