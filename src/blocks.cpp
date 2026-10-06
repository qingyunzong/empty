#include "columnar/blocks.hpp"

#include <algorithm>
#include <cstring>
#include <istream>
#include <memory>
#include <ostream>
#include <random>

namespace columnar {

namespace {

constexpr char kMagic[4] = {'C', 'O', 'L', 'R'};
constexpr uint32_t kVersion = 1;

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

void set_bit(std::vector<uint8_t>& buf, uint64_t pos) {
    buf[pos / 8] |= static_cast<uint8_t>(1u << (pos % 8));
}

bool get_bit(const uint8_t* buf, uint64_t pos) {
    return (buf[pos / 8] >> (pos % 8)) & 1u;
}

// Little-endian bit order: value i occupies bits [i*w, (i+1)*w).
void pack_value(std::vector<uint8_t>& out, uint64_t bitpos, uint64_t raw, uint8_t w) {
    for (uint8_t b = 0; b < w; ++b)
        if ((raw >> b) & 1u)
            set_bit(out, bitpos + b);
}

int64_t unpack_value(const uint8_t* data, uint64_t index, uint8_t w) {
    uint64_t bitpos = index * w;
    uint64_t raw = 0;
    for (uint8_t b = 0; b < w; ++b)
        if (get_bit(data, bitpos + b))
            raw |= (uint64_t{1} << b);
    if (w < 64 && (raw & (uint64_t{1} << (w - 1))))
        raw |= (~uint64_t{0}) << w; // sign-extend
    return static_cast<int64_t>(raw);
}

uint8_t width_for(int64_t min_v, int64_t max_v) {
    for (uint8_t w = 1; w < 64; ++w) {
        __int128 lo = -(__int128{1} << (w - 1));
        __int128 hi = (__int128{1} << (w - 1)) - 1;
        if (min_v >= lo && max_v <= hi)
            return w;
    }
    return 64;
}

// ---- binary IO helpers (little-endian, explicit sizes) ----

void write_bytes(std::ostream& out, const void* p, size_t n) {
    out.write(static_cast<const char*>(p), static_cast<std::streamsize>(n));
    if (!out)
        throw Error("write failed");
}

template <class T> void write_pod(std::ostream& out, T v) { write_bytes(out, &v, sizeof v); }

void read_bytes(std::istream& in, void* p, size_t n, const char* what) {
    in.read(static_cast<char*>(p), static_cast<std::streamsize>(n));
    if (in.gcount() != static_cast<std::streamsize>(n))
        throw Error(std::string("truncated while reading ") + what);
}

template <class T> T read_pod(std::istream& in, const char* what) {
    T v{};
    read_bytes(in, &v, sizeof v, what);
    return v;
}

} // namespace

Block make_rle_block(const int64_t* values, const bool* nulls, uint32_t n) {
    Block b;
    b.enc = Block::Enc::Rle;
    b.rows = n;
    for (uint32_t i = 0; i < n;) {
        Run r{nulls[i], nulls[i] ? 0 : values[i], 1};
        while (i + r.length < n && nulls[i + r.length] == r.is_null &&
               (r.is_null || values[i + r.length] == r.value))
            ++r.length;
        b.runs.push_back(r);
        i += r.length;
    }
    return b;
}

Block make_bitpack_block(const int64_t* values, const bool* nulls, uint32_t n) {
    Block b;
    b.enc = Block::Enc::BitPack;
    b.rows = n;
    int64_t min_v = 0, max_v = 0;
    bool any = false;
    for (uint32_t i = 0; i < n; ++i) {
        if (nulls[i])
            continue;
        if (!any) { min_v = max_v = values[i]; any = true; }
        min_v = std::min(min_v, values[i]);
        max_v = std::max(max_v, values[i]);
    }
    b.bit_width = any ? width_for(min_v, max_v) : 1;
    b.null_bitmap.assign((n + 7) / 8, 0);
    b.packed.assign((uint64_t{n} * b.bit_width + 7) / 8, 0);
    for (uint32_t i = 0; i < n; ++i) {
        if (nulls[i]) {
            set_bit(b.null_bitmap, i);
            continue; // packed slot stays zero
        }
        uint64_t raw = b.bit_width < 64
            ? (static_cast<uint64_t>(values[i]) & ((uint64_t{1} << b.bit_width) - 1))
            : static_cast<uint64_t>(values[i]);
        pack_value(b.packed, uint64_t{i} * b.bit_width, raw, b.bit_width);
    }
    return b;
}

Column generate_column(uint64_t rows, uint64_t seed) {
    std::mt19937_64 rng(seed);
    Column col;
    col.name = "col";
    col.num_rows = rows;
    std::vector<int64_t> values;
    std::vector<char> nulls;
    uint64_t done = 0;
    while (done < rows) {
        uint32_t n = 1 + static_cast<uint32_t>(rng() % 256);
        if (done + n > rows)
            n = static_cast<uint32_t>(rows - done);
        values.resize(n);
        nulls.resize(n);
        for (uint32_t i = 0; i < n; ++i) {
            nulls[i] = (rng() % 100) < 10;
            uint64_t pick = rng() % 100;
            if (i > 0 && pick < 55) {
                values[i] = values[i - 1]; // build runs for RLE
            } else if (pick < 90) {
                values[i] = static_cast<int64_t>(rng() % 2001) - 1000;
            } else if (pick < 95) {
                values[i] = INT64_MAX;
            } else if (pick < 98) {
                values[i] = INT64_MIN;
            } else {
                values[i] = static_cast<int64_t>(rng());
            }
        }
        auto null_ptr = std::make_unique<bool[]>(n);
        for (uint32_t i = 0; i < n; ++i)
            null_ptr[i] = nulls[i] != 0;
        const bool use_rle = (rng() % 2) == 0;
        col.blocks.push_back(use_rle ? make_rle_block(values.data(), null_ptr.get(), n)
                                     : make_bitpack_block(values.data(), null_ptr.get(), n));
        done += n;
    }
    return col;
}

void write_column(std::ostream& out, const Column& col) {
    write_bytes(out, kMagic, sizeof kMagic);
    write_pod(out, kVersion);
    write_pod(out, uint32_t{1}); // column count
    write_pod(out, uint32_t(col.name.size()));
    write_bytes(out, col.name.data(), col.name.size());
    write_pod(out, col.num_rows);
    write_pod(out, uint32_t(col.blocks.size()));
    for (const Block& b : col.blocks) {
        write_pod(out, static_cast<uint8_t>(b.enc));
        write_pod(out, b.rows);
        if (b.enc == Block::Enc::Rle) {
            write_pod(out, uint32_t(b.runs.size()));
            for (const Run& r : b.runs) {
                write_pod(out, uint8_t(r.is_null ? 1 : 0));
                write_pod(out, r.value);
                write_pod(out, r.length);
            }
        } else {
            write_pod(out, b.bit_width);
            write_pod(out, uint32_t(b.null_bitmap.size()));
            write_bytes(out, b.null_bitmap.data(), b.null_bitmap.size());
            write_pod(out, uint32_t(b.packed.size()));
            write_bytes(out, b.packed.data(), b.packed.size());
        }
    }
}

Column read_column(std::istream& in) {
    char magic[4];
    read_bytes(in, magic, 4, "magic");
    if (std::memcmp(magic, kMagic, 4) != 0)
        throw Error("bad magic: not a columnar file");
    if (read_pod<uint32_t>(in, "version") != kVersion)
        throw Error("unsupported version");
    if (read_pod<uint32_t>(in, "column count") != 1)
        throw Error("expected exactly one column");

    Column col;
    uint32_t name_len = read_pod<uint32_t>(in, "name length");
    if (name_len > (1u << 20))
        throw Error("column name too long");
    col.name.resize(name_len);
    read_bytes(in, col.name.data(), name_len, "column name");
    col.num_rows = read_pod<uint64_t>(in, "row count");
    uint32_t num_blocks = read_pod<uint32_t>(in, "block count");
    if (col.num_rows == 0 && num_blocks != 0)
        throw Error("empty column must have no blocks");
    if (num_blocks > col.num_rows)
        throw Error("block count exceeds row count");

    uint64_t total = 0;
    for (uint32_t bi = 0; bi < num_blocks; ++bi) {
        Block b;
        uint8_t enc = read_pod<uint8_t>(in, "block encoding");
        if (enc != uint8_t(Block::Enc::Rle) && enc != uint8_t(Block::Enc::BitPack))
            throw Error("unknown block encoding");
        b.enc = static_cast<Block::Enc>(enc);
        b.rows = read_pod<uint32_t>(in, "block rows");
        if (b.rows == 0)
            throw Error("empty block");
        if (b.enc == Block::Enc::Rle) {
            uint32_t num_runs = read_pod<uint32_t>(in, "run count");
            if (num_runs == 0 || num_runs > b.rows)
                throw Error("invalid run count");
            uint64_t run_rows = 0;
            for (uint32_t ri = 0; ri < num_runs; ++ri) {
                Run r;
                r.is_null = read_pod<uint8_t>(in, "run flag") != 0;
                r.value = read_pod<int64_t>(in, "run value");
                r.length = read_pod<uint32_t>(in, "run length");
                if (r.length == 0)
                    throw Error("zero-length run");
                run_rows += r.length;
                if (run_rows > b.rows)
                    throw Error("run lengths exceed block rows");
                b.runs.push_back(r);
            }
            if (run_rows != b.rows)
                throw Error("run lengths do not sum to block rows");
        } else {
            b.bit_width = read_pod<uint8_t>(in, "bit width");
            if (b.bit_width < 1 || b.bit_width > 64)
                throw Error("invalid bit width");
            uint32_t bm = read_pod<uint32_t>(in, "null bitmap size");
            if (bm != (b.rows + 7) / 8)
                throw Error("null bitmap size mismatch");
            b.null_bitmap.resize(bm);
            read_bytes(in, b.null_bitmap.data(), bm, "null bitmap");
            uint32_t pk = read_pod<uint32_t>(in, "packed size");
            if (pk != (uint64_t{b.rows} * b.bit_width + 7) / 8)
                throw Error("packed data size mismatch");
            b.packed.resize(pk);
            read_bytes(in, b.packed.data(), pk, "packed data");
        }
        total += b.rows;
        if (total > col.num_rows)
            throw Error("block rows exceed column rows");
        col.blocks.push_back(std::move(b));
    }
    if (total != col.num_rows)
        throw Error("block rows do not sum to column rows");
    if (in.peek() != std::istream::traits_type::eof())
        throw Error("trailing bytes after column data");
    return col;
}

void decode(const Column& col, std::vector<int64_t>& values, std::vector<bool>& nulls) {
    values.clear();
    nulls.clear();
    values.reserve(col.num_rows);
    nulls.reserve(col.num_rows);
    for (const Block& b : col.blocks) {
        if (b.enc == Block::Enc::Rle) {
            for (const Run& r : b.runs)
                for (uint32_t k = 0; k < r.length; ++k) {
                    values.push_back(r.value);
                    nulls.push_back(r.is_null);
                }
        } else {
            for (uint32_t i = 0; i < b.rows; ++i) {
                bool is_null = get_bit(b.null_bitmap.data(), i);
                values.push_back(is_null ? 0 : unpack_value(b.packed.data(), i, b.bit_width));
                nulls.push_back(is_null);
            }
        }
    }
}

std::vector<uint64_t> filter_positions(const Column& col, CmpOp op, int64_t v) {
    std::vector<uint64_t> out;
    uint64_t base = 0;
    for (const Block& b : col.blocks) {
        if (b.enc == Block::Enc::Rle) {
            for (const Run& r : b.runs) {
                if (!r.is_null && cmp(op, r.value, v))
                    for (uint32_t k = 0; k < r.length; ++k)
                        out.push_back(base + k);
                base += r.length;
            }
        } else {
            for (uint32_t i = 0; i < b.rows; ++i) {
                if (get_bit(b.null_bitmap.data(), i))
                    continue;
                if (cmp(op, unpack_value(b.packed.data(), i, b.bit_width), v))
                    out.push_back(base + i);
            }
            base += b.rows;
        }
    }
    return out;
}

AggResult aggregate(const Column& col) {
    AggResult res;
    res.count = col.num_rows; // nulls count toward the row total
    for (const Block& b : col.blocks) {
        if (b.enc == Block::Enc::Rle) {
            for (const Run& r : b.runs)
                if (!r.is_null)
                    res.sum += __int128(r.value) * r.length;
        } else {
            for (uint32_t i = 0; i < b.rows; ++i) {
                if (get_bit(b.null_bitmap.data(), i))
                    continue;
                res.sum += unpack_value(b.packed.data(), i, b.bit_width);
            }
        }
    }
    return res;
}

AggResult aggregate(const Column& col, CmpOp op, int64_t v) {
    AggResult res;
    for (const Block& b : col.blocks) {
        if (b.enc == Block::Enc::Rle) {
            for (const Run& r : b.runs) {
                if (!r.is_null && cmp(op, r.value, v)) {
                    res.count += r.length;
                    res.sum += __int128(r.value) * r.length;
                }
            }
        } else {
            for (uint32_t i = 0; i < b.rows; ++i) {
                if (get_bit(b.null_bitmap.data(), i))
                    continue;
                int64_t val = unpack_value(b.packed.data(), i, b.bit_width);
                if (cmp(op, val, v)) {
                    ++res.count;
                    res.sum += val;
                }
            }
        }
    }
    return res;
}

CmpOp parse_op(const std::string& s) {
    if (s == "=" || s == "==") return CmpOp::Eq;
    if (s == "!=") return CmpOp::Ne;
    if (s == "<") return CmpOp::Lt;
    if (s == "<=") return CmpOp::Le;
    if (s == ">") return CmpOp::Gt;
    if (s == ">=") return CmpOp::Ge;
    throw Error("unknown comparison operator: " + s);
}

std::string to_string_i128(__int128 v) {
    if (v == 0)
        return "0";
    bool neg = v < 0;
    unsigned __int128 u = neg ? -static_cast<unsigned __int128>(v)
                              : static_cast<unsigned __int128>(v);
    std::string s;
    while (u > 0) {
        s.push_back(static_cast<char>('0' + u % 10));
        u /= 10;
    }
    if (neg)
        s.push_back('-');
    std::reverse(s.begin(), s.end());
    return s;
}

} // namespace columnar
