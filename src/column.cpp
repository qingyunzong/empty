#include "column.hpp"

#include <algorithm>
#include <cstring>

namespace col {
namespace {

void append_le(std::vector<uint8_t>& out, uint64_t v, unsigned bytes) {
  for (unsigned i = 0; i < bytes; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
}

uint64_t read_le(const uint8_t* p, unsigned bytes) {
  uint64_t v = 0;
  for (unsigned i = 0; i < bytes; ++i) v |= static_cast<uint64_t>(p[i]) << (8 * i);
  return v;
}

struct Cursor {
  const uint8_t* p;
  size_t len;
  size_t off = 0;

  void need(size_t n) const {
    if (n > len - off) throw ColumnError("unexpected end of data");
  }
  uint8_t u8() {
    need(1);
    return p[off++];
  }
  uint64_t le(unsigned bytes) {
    need(bytes);
    uint64_t v = read_le(p + off, bytes);
    off += bytes;
    return v;
  }
  const uint8_t* take(size_t n) {
    need(n);
    const uint8_t* r = p + off;
    off += n;
    return r;
  }
  bool at_end() const { return off == len; }
};

// Extract `width` bits starting at bit position `bitpos` (little-endian bit
// order). Caller guarantees the referenced bytes are in bounds.
uint64_t get_bits(const uint8_t* data, size_t bitpos, unsigned width) {
  if (width == 0) return 0;
  size_t byte = bitpos / 8;
  unsigned off = static_cast<unsigned>(bitpos % 8);
  unsigned __int128 acc = 0;
  unsigned got = 0;
  while (got < off + width) {
    acc |= static_cast<unsigned __int128>(data[byte++]) << got;
    got += 8;
  }
  return static_cast<uint64_t>((acc >> off) &
                               ((static_cast<unsigned __int128>(1) << width) - 1));
}

void put_bits(uint8_t* data, size_t bitpos, unsigned width, uint64_t value) {
  size_t bit = bitpos;
  unsigned remaining = width;
  unsigned src = 0;
  while (remaining > 0) {
    size_t byte = bit / 8;
    unsigned off = static_cast<unsigned>(bit % 8);
    unsigned take = std::min(remaining, 8u - off);
    auto bits = static_cast<uint8_t>((value >> src) & ((1u << take) - 1));
    data[byte] |= static_cast<uint8_t>(bits << off);
    src += take;
    remaining -= take;
    bit += take;
  }
}

bool cmp(CmpOp op, int64_t a, int64_t b) {
  switch (op) {
    case CmpOp::Eq: return a == b;
    case CmpOp::Ne: return a != b;
    case CmpOp::Lt: return a < b;
    case CmpOp::Le: return a <= b;
    case CmpOp::Gt: return a > b;
    case CmpOp::Ge: return a >= b;
  }
  return false;
}

unsigned bit_width(uint64_t v) {
  unsigned w = 0;
  while (v) {
    ++w;
    v >>= 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Block payload builders
// ---------------------------------------------------------------------------

std::vector<uint8_t> build_rle(const std::optional<int64_t>* rows, size_t n) {
  std::vector<uint8_t> out;
  std::vector<uint8_t> runs;
  uint32_t num_runs = 0;
  size_t i = 0;
  while (i < n) {
    size_t j = i + 1;
    while (j < n && rows[j].has_value() == rows[i].has_value() &&
           (!rows[i] || *rows[j] == *rows[i]))
      ++j;
    ++num_runs;
    runs.push_back(rows[i] ? uint8_t{0} : uint8_t{1});
    append_le(runs, rows[i] ? static_cast<uint64_t>(*rows[i]) : 0, 8);
    append_le(runs, j - i, 8);
    i = j;
  }
  append_le(out, num_runs, 4);
  out.insert(out.end(), runs.begin(), runs.end());
  return out;
}

std::vector<uint8_t> build_bitpack(const std::optional<int64_t>* rows, size_t n) {
  int64_t offset = 0;
  uint64_t max_delta = 0;
  bool any = false;
  for (size_t i = 0; i < n; ++i) {
    if (!rows[i]) continue;
    if (!any) {
      offset = *rows[i];
      max_delta = 0;
      any = true;
    } else {
      offset = std::min(offset, *rows[i]);
    }
  }
  for (size_t i = 0; i < n; ++i)
    if (rows[i])
      max_delta = std::max(max_delta,
                           static_cast<uint64_t>(*rows[i]) - static_cast<uint64_t>(offset));
  unsigned width = bit_width(max_delta);

  size_t bitmap_bytes = (n + 7) / 8;
  size_t packed_bytes = (n * static_cast<size_t>(width) + 7) / 8;
  std::vector<uint8_t> out;
  append_le(out, static_cast<uint64_t>(offset), 8);
  out.push_back(static_cast<uint8_t>(width));
  size_t bitmap_pos = out.size();
  out.resize(out.size() + bitmap_bytes, 0);
  size_t packed_pos = out.size();
  out.resize(out.size() + packed_bytes, 0);
  for (size_t i = 0; i < n; ++i) {
    if (!rows[i]) {
      out[bitmap_pos + i / 8] |= static_cast<uint8_t>(1u << (i % 8));
    } else {
      uint64_t delta = static_cast<uint64_t>(*rows[i]) - static_cast<uint64_t>(offset);
      put_bits(out.data() + packed_pos, i * static_cast<size_t>(width), width, delta);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block validation / scanning
// ---------------------------------------------------------------------------

struct BlockInfo {
  uint8_t enc;
  uint64_t row_count;
  const uint8_t* payload;
  uint32_t payload_size;
};

// Parse and fully validate the file: magic, block structure, per-block
// checksums, payload shapes, and total row accounting. Any corruption throws
// ColumnError before a single row of work is produced.
std::vector<BlockInfo> validate(const uint8_t* data, size_t size) {
  Cursor c{data, size, 0};
  if (size < 4 || std::memcmp(c.take(4), kMagic, 4) != 0)
    throw ColumnError("bad magic");
  uint64_t total_rows = c.le(8);
  uint32_t num_blocks = static_cast<uint32_t>(c.le(4));

  // Each block needs at least a 17-byte header; reject impossible counts
  // before reserving memory based on an untrusted value.
  if (num_blocks > (c.len - c.off) / 17) throw ColumnError("block count out of range");

  std::vector<BlockInfo> blocks;
  blocks.reserve(num_blocks);
  uint64_t sum_rows = 0;
  for (uint32_t b = 0; b < num_blocks; ++b) {
    BlockInfo blk;
    blk.enc = c.u8();
    blk.row_count = c.le(8);
    blk.payload_size = static_cast<uint32_t>(c.le(4));
    uint32_t checksum = static_cast<uint32_t>(c.le(4));
    blk.payload = c.take(blk.payload_size);
    if (blk.enc != kEncRle && blk.enc != kEncBitpack)
      throw ColumnError("unknown block encoding");
    if (fnv1a(blk.payload, blk.payload_size) != checksum)
      throw ColumnError("block checksum mismatch");

    // Validate payload shape.
    Cursor p{blk.payload, blk.payload_size, 0};
    if (blk.enc == kEncRle) {
      uint32_t num_runs = static_cast<uint32_t>(p.le(4));
      uint64_t counted = 0;
      for (uint32_t r = 0; r < num_runs; ++r) {
        uint8_t is_null = p.u8();
        if (is_null > 1) throw ColumnError("invalid null flag in RLE run");
        p.le(8);  // value
        uint64_t len = p.le(8);
        if (len == 0) throw ColumnError("zero-length RLE run");
        counted += len;
        if (counted < len) throw ColumnError("RLE run lengths overflow");
      }
      if (counted != blk.row_count) throw ColumnError("RLE runs do not cover block rows");
    } else {
      p.le(8);  // offset
      unsigned width = p.u8();
      if (width > 64) throw ColumnError("bit width out of range");
      unsigned __int128 expected = 9 + (static_cast<unsigned __int128>(blk.row_count) + 7) / 8 +
                                   (static_cast<unsigned __int128>(blk.row_count) * width + 7) / 8;
      if (expected != blk.payload_size) throw ColumnError("bit-packed payload size mismatch");
      p.off = blk.payload_size;
    }
    if (!p.at_end()) throw ColumnError("trailing bytes in block payload");

    sum_rows += blk.row_count;
    if (sum_rows < blk.row_count) throw ColumnError("row count overflow");
    blocks.push_back(blk);
  }
  if (!c.at_end()) throw ColumnError("trailing bytes after last block");
  if (sum_rows != total_rows) throw ColumnError("block row counts do not match header");
  return blocks;
}

template <typename F>
void scan_bitpack(const BlockInfo& blk, F&& on_value) {
  const uint8_t* p = blk.payload;
  int64_t offset = static_cast<int64_t>(read_le(p, 8));
  unsigned width = p[8];
  const uint8_t* bitmap = p + 9;
  const uint8_t* packed = bitmap + (blk.row_count + 7) / 8;
  for (uint64_t i = 0; i < blk.row_count; ++i) {
    if (bitmap[i / 8] & (1u << (i % 8))) continue;  // null
    uint64_t delta = get_bits(packed, static_cast<size_t>(i) * width, width);
    int64_t value = static_cast<int64_t>(static_cast<uint64_t>(offset) + delta);
    on_value(i, value);
  }
}

template <typename F>
void scan_rle(const BlockInfo& blk, F&& on_run) {
  Cursor p{blk.payload, blk.payload_size, 0};
  uint32_t num_runs = static_cast<uint32_t>(p.le(4));
  uint64_t pos = 0;
  for (uint32_t r = 0; r < num_runs; ++r) {
    uint8_t is_null = p.u8();
    int64_t value = static_cast<int64_t>(p.le(8));
    uint64_t len = p.le(8);
    on_run(pos, is_null != 0, value, len);
    pos += len;
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

std::vector<uint8_t> encode_column(const std::vector<std::optional<int64_t>>& rows,
                                   uint64_t max_block_rows,
                                   std::optional<uint8_t> force_encoding) {
  if (max_block_rows == 0) throw ColumnError("block size must be positive");
  if (force_encoding && *force_encoding != kEncRle && *force_encoding != kEncBitpack)
    throw ColumnError("invalid forced encoding");

  std::vector<uint8_t> out;
  out.insert(out.end(), std::begin(kMagic), std::end(kMagic));
  append_le(out, rows.size(), 8);
  uint64_t num_blocks = (rows.size() + max_block_rows - 1) / max_block_rows;
  append_le(out, num_blocks, 4);

  for (uint64_t start = 0; start < rows.size(); start += max_block_rows) {
    size_t n = static_cast<size_t>(std::min<uint64_t>(max_block_rows, rows.size() - start));
    const auto* chunk = rows.data() + start;
    std::vector<uint8_t> rle = build_rle(chunk, n);
    std::vector<uint8_t> bp = build_bitpack(chunk, n);
    uint8_t enc = force_encoding.value_or(rle.size() <= bp.size() ? kEncRle : kEncBitpack);
    const std::vector<uint8_t>& payload = (enc == kEncRle) ? rle : bp;
    out.push_back(enc);
    append_le(out, n, 8);
    append_le(out, payload.size(), 4);
    append_le(out, fnv1a(payload.data(), payload.size()), 4);
    out.insert(out.end(), payload.begin(), payload.end());
  }
  return out;
}

AggResult aggregate(const uint8_t* data, size_t size) {
  std::vector<BlockInfo> blocks = validate(data, size);  // all-or-nothing
  AggResult r;
  for (const BlockInfo& blk : blocks) {
    r.rows += blk.row_count;
    if (blk.enc == kEncRle) {
      scan_rle(blk, [&](uint64_t, bool is_null, int64_t value, uint64_t len) {
        if (!is_null) {
          r.non_null += len;
          r.sum += static_cast<__int128>(value) * len;
        }
      });
    } else {
      scan_bitpack(blk, [&](uint64_t, int64_t value) {
        ++r.non_null;
        r.sum += value;
      });
    }
  }
  return r;
}

std::vector<uint64_t> filter_positions(const uint8_t* data, size_t size, CmpOp op,
                                       int64_t rhs) {
  std::vector<BlockInfo> blocks = validate(data, size);  // all-or-nothing
  std::vector<uint64_t> out;
  uint64_t base = 0;
  for (const BlockInfo& blk : blocks) {
    if (blk.enc == kEncRle) {
      scan_rle(blk, [&](uint64_t pos, bool is_null, int64_t value, uint64_t len) {
        if (!is_null && cmp(op, value, rhs))
          for (uint64_t i = 0; i < len; ++i) out.push_back(base + pos + i);
      });
    } else {
      scan_bitpack(blk, [&](uint64_t i, int64_t value) {
        if (cmp(op, value, rhs)) out.push_back(base + i);
      });
    }
    base += blk.row_count;
  }
  return out;
}

std::string to_string_i128(__int128 v) {
  if (v == 0) return "0";
  bool neg = v < 0;
  if (neg) v = -v;
  std::string s;
  while (v > 0) {
    s.push_back(static_cast<char>('0' + v % 10));
    v /= 10;
  }
  if (neg) s.push_back('-');
  std::reverse(s.begin(), s.end());
  return s;
}

bool parse_op(const std::string& s, CmpOp& out) {
  if (s == "eq") out = CmpOp::Eq;
  else if (s == "ne") out = CmpOp::Ne;
  else if (s == "lt") out = CmpOp::Lt;
  else if (s == "le") out = CmpOp::Le;
  else if (s == "gt") out = CmpOp::Gt;
  else if (s == "ge") out = CmpOp::Ge;
  else return false;
  return true;
}

}  // namespace col
