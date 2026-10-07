#include "pgc/page_compressor.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string_view>

namespace pgc {
namespace {

constexpr std::uint32_t kPageMagic = 0x50474331;   // "PGC1"
constexpr std::uint32_t kFileMagic = 0x50474341;   // "PGCA"
constexpr std::size_t kPageHeaderSize = 16;        // magic + count + checksum + payload size
constexpr std::size_t kVersionSize = sizeof(std::uint64_t);

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3 polynomial)
// ---------------------------------------------------------------------------

std::uint32_t crc32(std::string_view data) {
    static const std::array<std::uint32_t, 256> table = [] {
        std::array<std::uint32_t, 256> t{};
        for (std::uint32_t i = 0; i < 256; ++i) {
            std::uint32_t c = i;
            for (int k = 0; k < 8; ++k)
                c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            t[i] = c;
        }
        return t;
    }();
    std::uint32_t crc = 0xFFFFFFFFu;
    for (unsigned char b : data)
        crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

// ---------------------------------------------------------------------------
// Little-endian scalar and varint encoding helpers
// ---------------------------------------------------------------------------

void put_u32(std::string& out, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
}

void put_u64(std::string& out, std::uint64_t v) {
    for (int i = 0; i < 8; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
}

bool get_u32(std::string_view& in, std::uint32_t& v) {
    if (in.size() < 4) return false;
    v = 0;
    for (int i = 0; i < 4; ++i)
        v |= static_cast<std::uint32_t>(static_cast<unsigned char>(in[i])) << (8 * i);
    in.remove_prefix(4);
    return true;
}

bool get_u64(std::string_view& in, std::uint64_t& v) {
    if (in.size() < 8) return false;
    v = 0;
    for (int i = 0; i < 8; ++i)
        v |= static_cast<std::uint64_t>(static_cast<unsigned char>(in[i])) << (8 * i);
    in.remove_prefix(8);
    return true;
}

void put_varint(std::string& out, std::uint64_t v) {
    while (v >= 0x80) {
        out.push_back(static_cast<char>((v & 0x7F) | 0x80));
        v >>= 7;
    }
    out.push_back(static_cast<char>(v));
}

std::size_t varint_len(std::uint64_t v) {
    std::size_t n = 1;
    while (v >= 0x80) { v >>= 7; ++n; }
    return n;
}

bool get_varint(std::string_view& in, std::uint64_t& v) {
    v = 0;
    int shift = 0;
    while (!in.empty() && shift < 64) {
        const auto b = static_cast<unsigned char>(in.front());
        in.remove_prefix(1);
        v |= static_cast<std::uint64_t>(b & 0x7F) << shift;
        if ((b & 0x80) == 0) return true;
        shift += 7;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Entry encoding: <shared varint><suffix varint><suffix><version u64><value varint><value>
// ---------------------------------------------------------------------------

std::size_t entry_size(std::size_t shared, std::size_t suffix_len, std::size_t value_len) {
    return varint_len(shared) + varint_len(suffix_len) + suffix_len + kVersionSize +
           varint_len(value_len) + value_len;
}

void append_entry(std::string& payload, std::size_t shared, std::string_view suffix,
                  std::uint64_t version, std::string_view value) {
    put_varint(payload, shared);
    put_varint(payload, suffix.size());
    payload.append(suffix);
    put_u64(payload, version);
    put_varint(payload, value.size());
    payload.append(value);
}

std::size_t common_prefix(std::string_view a, std::string_view b) {
    const std::size_t n = std::min(a.size(), b.size());
    std::size_t i = 0;
    while (i < n && a[i] == b[i]) ++i;
    return i;
}

Error corrupt(const char* detail) {
    return Error{ErrorCode::CorruptData, std::string("corrupt archive: ") + detail};
}

} // namespace

Expected<Archive> build(std::vector<Record> records, const BuildOptions& options) {
    std::sort(records.begin(), records.end(), [](const Record& a, const Record& b) {
        if (a.key != b.key) return a.key < b.key;
        return a.version < b.version;
    });

    Archive archive;
    std::string payload;
    std::string prev_key;
    std::string first_key;
    std::uint32_t count = 0;

    auto flush = [&] {
        PageInfo info;
        info.first_key = first_key;
        info.offset = archive.data.size();
        info.size = static_cast<std::uint32_t>(kPageHeaderSize + payload.size());
        info.checksum = crc32(payload);
        info.record_count = count;
        put_u32(archive.data, kPageMagic);
        put_u32(archive.data, count);
        put_u32(archive.data, info.checksum);
        put_u32(archive.data, static_cast<std::uint32_t>(payload.size()));
        archive.data.append(payload);
        archive.index.push_back(std::move(info));
        payload.clear();
        prev_key.clear();
        count = 0;
    };

    for (const Record& rec : records) {
        const bool page_empty = payload.empty();
        std::size_t shared = page_empty ? 0 : common_prefix(prev_key, rec.key);
        std::size_t size = entry_size(shared, rec.key.size() - shared, rec.value.size());

        // Reject a record that cannot fit even in an otherwise empty page.
        if (kPageHeaderSize + size > options.page_budget) {
            return Expected<Archive>::err(Error{
                ErrorCode::RecordTooLarge,
                "record key '" + rec.key + "' needs " + std::to_string(kPageHeaderSize + size) +
                    " bytes compressed, exceeding page budget " +
                    std::to_string(options.page_budget)});
        }

        // Page boundary: decided against the actual compressed byte sizes.
        if (!page_empty && kPageHeaderSize + payload.size() + size > options.page_budget) {
            flush();
            shared = 0;
            size = entry_size(0, rec.key.size(), rec.value.size());
        }

        if (payload.empty()) first_key = rec.key;
        append_entry(payload, shared, std::string_view(rec.key).substr(shared), rec.version,
                     rec.value);
        prev_key = rec.key;
        ++count;
    }
    if (!payload.empty()) flush();

    return Expected<Archive>::ok(std::move(archive));
}

Expected<std::vector<Record>> decompress(const Archive& archive) {
    std::vector<Record> records;
    for (const PageInfo& page : archive.index) {
        if (page.size < kPageHeaderSize ||
            page.offset + page.size > archive.data.size())
            return Expected<std::vector<Record>>::err(corrupt("page out of bounds"));

        std::string_view raw(archive.data.data() + page.offset, page.size);
        std::uint32_t magic = 0, count = 0, checksum = 0, payload_size = 0;
        if (!get_u32(raw, magic) || !get_u32(raw, count) || !get_u32(raw, checksum) ||
            !get_u32(raw, payload_size))
            return Expected<std::vector<Record>>::err(corrupt("truncated page header"));
        if (magic != kPageMagic)
            return Expected<std::vector<Record>>::err(corrupt("bad page magic"));
        if (payload_size != raw.size())
            return Expected<std::vector<Record>>::err(corrupt("page size mismatch"));
        if (crc32(raw) != checksum)
            return Expected<std::vector<Record>>::err(
                Error{ErrorCode::ChecksumMismatch,
                      "page at offset " + std::to_string(page.offset) + " failed checksum"});

        std::string prev_key;
        for (std::uint32_t i = 0; i < count; ++i) {
            std::uint64_t shared = 0, suffix_len = 0, version = 0, value_len = 0;
            if (!get_varint(raw, shared) || !get_varint(raw, suffix_len))
                return Expected<std::vector<Record>>::err(corrupt("truncated entry header"));
            if (shared > prev_key.size() || suffix_len > raw.size())
                return Expected<std::vector<Record>>::err(corrupt("bad prefix lengths"));
            Record rec;
            rec.key = prev_key.substr(0, shared);
            rec.key.append(raw.substr(0, suffix_len));
            raw.remove_prefix(suffix_len);
            if (!get_u64(raw, version) || !get_varint(raw, value_len) ||
                value_len > raw.size())
                return Expected<std::vector<Record>>::err(corrupt("truncated entry body"));
            rec.version = version;
            rec.value = raw.substr(0, value_len);
            raw.remove_prefix(value_len);
            prev_key = rec.key;
            records.push_back(std::move(rec));
        }
        if (!raw.empty())
            return Expected<std::vector<Record>>::err(corrupt("trailing bytes in page"));
    }
    return Expected<std::vector<Record>>::ok(std::move(records));
}

std::string serialize(const Archive& archive) {
    std::string out;
    put_u32(out, kFileMagic);
    put_varint(out, archive.index.size());
    for (const PageInfo& page : archive.index) {
        put_varint(out, page.first_key.size());
        out.append(page.first_key);
        put_u64(out, page.offset);
        put_u32(out, page.size);
        put_u32(out, page.checksum);
        put_u32(out, page.record_count);
    }
    put_u64(out, archive.data.size());
    out.append(archive.data);
    put_u32(out, crc32(out));
    return out;
}

Expected<Archive> deserialize(const std::string& bytes) {
    std::string_view in(bytes);
    if (in.size() < 4)
        return Expected<Archive>::err(corrupt("file too small"));
    const std::uint32_t stored_crc = [&] {
        std::uint32_t v = 0;
        for (int i = 0; i < 4; ++i)
            v |= static_cast<std::uint32_t>(static_cast<unsigned char>(in[in.size() - 4 + i]))
                 << (8 * i);
        return v;
    }();
    if (crc32(in.substr(0, in.size() - 4)) != stored_crc)
        return Expected<Archive>::err(
            Error{ErrorCode::ChecksumMismatch, "archive file failed checksum"});
    in.remove_suffix(4);

    std::uint32_t magic = 0;
    std::uint64_t page_count = 0, data_size = 0;
    if (!get_u32(in, magic) || magic != kFileMagic)
        return Expected<Archive>::err(corrupt("bad file magic"));
    if (!get_varint(in, page_count))
        return Expected<Archive>::err(corrupt("truncated index"));

    Archive archive;
    for (std::uint64_t i = 0; i < page_count; ++i) {
        std::uint64_t key_len = 0;
        PageInfo page;
        if (!get_varint(in, key_len) || key_len > in.size())
            return Expected<Archive>::err(corrupt("truncated index key"));
        page.first_key = in.substr(0, key_len);
        in.remove_prefix(key_len);
        if (!get_u64(in, page.offset) || !get_u32(in, page.size) ||
            !get_u32(in, page.checksum) || !get_u32(in, page.record_count))
            return Expected<Archive>::err(corrupt("truncated index entry"));
        archive.index.push_back(std::move(page));
    }
    if (!get_u64(in, data_size) || data_size != in.size())
        return Expected<Archive>::err(corrupt("data size mismatch"));
    archive.data = in;
    return Expected<Archive>::ok(std::move(archive));
}

Expected<void> publish(const Archive& archive, const std::string& path) {
    namespace fs = std::filesystem;
    const fs::path target(path);
    const fs::path tmp = target.parent_path() / (target.filename().string() + ".tmp");
    std::error_code ec;

    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out)
            return Expected<void>::err(Error{ErrorCode::IoFailure,
                                             "cannot open temp file " + tmp.string()});
        const std::string bytes = serialize(archive);
        out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        out.flush();
        if (!out) {
            fs::remove(tmp, ec);
            return Expected<void>::err(
                Error{ErrorCode::IoFailure, "failed writing temp file " + tmp.string()});
        }
    }
    fs::rename(tmp, target, ec);
    if (ec) {
        fs::remove(tmp, ec);
        return Expected<void>::err(Error{ErrorCode::IoFailure,
                                         "failed to publish " + path + ": " + ec.message()});
    }
    return Expected<void>::ok();
}

Expected<Archive> load(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        return Expected<Archive>::err(
            Error{ErrorCode::IoFailure, "cannot open archive file " + path});
    const std::string bytes((std::istreambuf_iterator<char>(in)),
                            std::istreambuf_iterator<char>());
    return deserialize(bytes);
}

Expected<void> build_and_publish(std::vector<Record> records, const BuildOptions& options,
                                 const std::string& path) {
    auto built = build(std::move(records), options);
    if (!built) return Expected<void>::err(built.error());
    return publish(built.value(), path);
}

} // namespace pgc
