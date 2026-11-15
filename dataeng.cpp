#include "dataeng.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cctype>
#include <cstdint>
#include <istream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {
namespace {

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

bool is_space(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
           c == '\f' || c == '\v';
}

std::string_view trim_view(std::string_view value) {
    while (!value.empty() && is_space(static_cast<unsigned char>(value.front()))) {
        value.remove_prefix(1);
    }
    while (!value.empty() && is_space(static_cast<unsigned char>(value.back()))) {
        value.remove_suffix(1);
    }
    return value;
}

std::string trim_copy(std::string_view value) {
    return std::string(trim_view(value));
}

std::string lower_ascii(std::string_view value) {
    std::string out;
    out.reserve(value.size());
    for (char c : value) {
        if (c >= 'A' && c <= 'Z') {
            out.push_back(static_cast<char>(c - 'A' + 'a'));
        } else {
            out.push_back(c);
        }
    }
    return out;
}

bool iequals(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        unsigned char ca = static_cast<unsigned char>(a[i]);
        unsigned char cb = static_cast<unsigned char>(b[i]);
        if (std::tolower(ca) != std::tolower(cb)) {
            return false;
        }
    }
    return true;
}

bool starts_with_ci(std::string_view value, std::string_view prefix) {
    return value.size() >= prefix.size() &&
           iequals(value.substr(0, prefix.size()), prefix);
}

std::optional<std::uint64_t> parse_uint(std::string_view text) {
    text = trim_view(text);
    if (text.empty()) {
        return std::nullopt;
    }
    std::uint64_t value = 0;
    const char* begin = text.data();
    const char* end = text.data() + text.size();
    auto result = std::from_chars(begin, end, value, 10);
    if (result.ec != std::errc{} || result.ptr != end) {
        return std::nullopt;
    }
    return value;
}

std::string bytes_to_hex(const std::uint8_t* data, std::size_t size) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.resize(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        out[i * 2] = kHex[data[i] >> 4];
        out[i * 2 + 1] = kHex[data[i] & 0x0f];
    }
    return out;
}

int hex_nibble(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

std::optional<std::string> decode_hex(std::string_view text) {
    if (text.size() % 2 != 0) {
        return std::nullopt;
    }
    std::string out;
    out.resize(text.size() / 2);
    for (std::size_t i = 0; i < out.size(); ++i) {
        int hi = hex_nibble(text[i * 2]);
        int lo = hex_nibble(text[i * 2 + 1]);
        if (hi < 0 || lo < 0) {
            return std::nullopt;
        }
        out[i] = static_cast<char>((hi << 4) | lo);
    }
    return out;
}

int base32_value(char c, bool hex_alphabet = false) {
    if (hex_alphabet) {
        if (c >= '0' && c <= '9') {
            return c - '0';
        }
        if (c >= 'A' && c <= 'V') {
            return c - 'A' + 10;
        }
        if (c >= 'a' && c <= 'v') {
            return c - 'a' + 10;
        }
        return -1;
    }
    if (c >= 'A' && c <= 'Z') {
        return c - 'A';
    }
    if (c >= 'a' && c <= 'z') {
        return c - 'a';
    }
    if (c >= '2' && c <= '7') {
        return c - '2' + 26;
    }
    return -1;
}

std::string base32_encode(const std::uint8_t* data, std::size_t size) {
    static constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    std::string out;
    std::uint32_t buffer = 0;
    int bits = 0;
    for (std::size_t i = 0; i < size; ++i) {
        buffer = (buffer << 8) | data[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out.push_back(kAlphabet[(buffer >> bits) & 0x1f]);
        }
    }
    if (bits > 0) {
        out.push_back(kAlphabet[(buffer << (5 - bits)) & 0x1f]);
    }
    return out;
}

std::optional<std::string> base32_decode(std::string_view text,
                                         bool hex_alphabet = false) {
    while (!text.empty() && text.back() == '=') {
        text.remove_suffix(1);
    }
    if (text.empty()) {
        return std::string();
    }
    std::string out;
    std::uint32_t buffer = 0;
    int bits = 0;
    for (char c : text) {
        int value = base32_value(c, hex_alphabet);
        if (value < 0) {
            return std::nullopt;
        }
        buffer = (buffer << 5) | static_cast<std::uint32_t>(value);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((buffer >> bits) & 0xff));
        }
    }
    if (bits > 0 && ((buffer & ((1u << bits) - 1u)) != 0)) {
        return std::nullopt;
    }
    return out;
}

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------

std::array<std::uint8_t, 16> md5_bytes(std::string_view input) {
    static constexpr std::uint32_t kK[64] = {
        0xd76aa478u, 0xe8c7b756u, 0x242070dbu, 0xc1bdceeeu, 0xf57c0fafu,
        0x4787c62au, 0xa8304613u, 0xfd469501u, 0x698098d8u, 0x8b44f7afu,
        0xffff5bb1u, 0x895cd7beu, 0x6b901122u, 0xfd987193u, 0xa679438eu,
        0x49b40821u, 0xf61e2562u, 0xc040b340u, 0x265e5a51u, 0xe9b6c7aau,
        0xd62f105du, 0x02441453u, 0xd8a1e681u, 0xe7d3fbc8u, 0x21e1cde6u,
        0xc33707d6u, 0xf4d50d87u, 0x455a14edu, 0xa9e3e905u, 0xfcefa3f8u,
        0x676f02d9u, 0x8d2a4c8au, 0xfffa3942u, 0x8771f681u, 0x6d9d6122u,
        0xfde5380cu, 0xa4beea44u, 0x4bdecfa9u, 0xf6bb4b60u, 0xbebfbc70u,
        0x289b7ec6u, 0xeaa127fau, 0xd4ef3085u, 0x04881d05u, 0xd9d4d039u,
        0xe6db99e5u, 0x1fa27cf8u, 0xc4ac5665u, 0xf4292244u, 0x432aff97u,
        0xab9423a7u, 0xfc93a039u, 0x655b59c3u, 0x8f0ccc92u, 0xffeff47du,
        0x85845dd1u, 0x6fa87e4fu, 0xfe2ce6e0u, 0xa3014314u, 0x4e0811a1u,
        0xf7537e82u, 0xbd3af235u, 0x2ad7d2bbu, 0xeb86d391u};
    static constexpr int kS[64] = {
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9,  14, 20, 5, 9,  14, 20, 5, 9,  14, 20, 5, 9,  14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

    std::vector<std::uint8_t> message(input.begin(), input.end());
    std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8u;
    message.push_back(0x80);
    while (message.size() % 64 != 56) {
        message.push_back(0);
    }
    for (int i = 0; i < 8; ++i) {
        message.push_back(static_cast<std::uint8_t>((bit_length >> (i * 8)) & 0xff));
    }

    std::uint32_t a0 = 0x67452301u;
    std::uint32_t b0 = 0xefcdab89u;
    std::uint32_t c0 = 0x98badcfeu;
    std::uint32_t d0 = 0x10325476u;

    for (std::size_t offset = 0; offset < message.size(); offset += 64) {
        std::uint32_t m[16];
        for (int i = 0; i < 16; ++i) {
            std::size_t p = offset + static_cast<std::size_t>(i) * 4;
            m[i] = static_cast<std::uint32_t>(message[p]) |
                   (static_cast<std::uint32_t>(message[p + 1]) << 8) |
                   (static_cast<std::uint32_t>(message[p + 2]) << 16) |
                   (static_cast<std::uint32_t>(message[p + 3]) << 24);
        }
        std::uint32_t a = a0;
        std::uint32_t b = b0;
        std::uint32_t c = c0;
        std::uint32_t d = d0;
        for (int i = 0; i < 64; ++i) {
            std::uint32_t f = 0;
            int g = 0;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            std::uint32_t tmp = d;
            d = c;
            c = b;
            std::uint32_t rotated = a + f + kK[i] + m[g];
            b = b + ((rotated << kS[i]) | (rotated >> (32 - kS[i])));
            a = tmp;
        }
        a0 += a;
        b0 += b;
        c0 += c;
        d0 += d;
    }

    std::array<std::uint8_t, 16> digest{};
    std::uint32_t words[4] = {a0, b0, c0, d0};
    for (int i = 0; i < 4; ++i) {
        for (int j = 0; j < 4; ++j) {
            digest[static_cast<std::size_t>(i) * 4 + static_cast<std::size_t>(j)] =
                static_cast<std::uint8_t>((words[i] >> (j * 8)) & 0xff);
        }
    }
    return digest;
}

// ---------------------------------------------------------------------------
// SHA-1
// ---------------------------------------------------------------------------

std::array<std::uint8_t, 20> sha1_bytes(std::string_view input) {
    std::vector<std::uint8_t> message(input.begin(), input.end());
    std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8u;
    message.push_back(0x80);
    while (message.size() % 64 != 56) {
        message.push_back(0);
    }
    for (int i = 7; i >= 0; --i) {
        message.push_back(static_cast<std::uint8_t>((bit_length >> (i * 8)) & 0xff));
    }

    std::uint32_t h0 = 0x67452301u;
    std::uint32_t h1 = 0xefcdab89u;
    std::uint32_t h2 = 0x98badcfeu;
    std::uint32_t h3 = 0x10325476u;
    std::uint32_t h4 = 0xc3d2e1f0u;

    auto rotl = [](std::uint32_t value, int bits) {
        return (value << bits) | (value >> (32 - bits));
    };

    for (std::size_t offset = 0; offset < message.size(); offset += 64) {
        std::uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            std::size_t p = offset + static_cast<std::size_t>(i) * 4;
            w[i] = (static_cast<std::uint32_t>(message[p]) << 24) |
                   (static_cast<std::uint32_t>(message[p + 1]) << 16) |
                   (static_cast<std::uint32_t>(message[p + 2]) << 8) |
                   static_cast<std::uint32_t>(message[p + 3]);
        }
        for (int i = 16; i < 80; ++i) {
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        }
        std::uint32_t a = h0;
        std::uint32_t b = h1;
        std::uint32_t c = h2;
        std::uint32_t d = h3;
        std::uint32_t e = h4;
        for (int i = 0; i < 80; ++i) {
            std::uint32_t f = 0;
            std::uint32_t k = 0;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999u;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1u;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdcu;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6u;
            }
            std::uint32_t tmp = rotl(a, 5) + f + e + k + w[i];
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = tmp;
        }
        h0 += a;
        h1 += b;
        h2 += c;
        h3 += d;
        h4 += e;
    }

    std::array<std::uint8_t, 20> digest{};
    std::uint32_t words[5] = {h0, h1, h2, h3, h4};
    for (int i = 0; i < 5; ++i) {
        for (int j = 0; j < 4; ++j) {
            digest[static_cast<std::size_t>(i) * 4 + static_cast<std::size_t>(j)] =
                static_cast<std::uint8_t>((words[i] >> ((3 - j) * 8)) & 0xff);
        }
    }
    return digest;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

std::array<std::uint8_t, 32> sha256_bytes(std::string_view input) {
    static constexpr std::uint32_t kK[64] = {
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
        0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
        0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
        0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
        0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
        0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
        0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
        0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
        0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
        0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
        0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
        0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

    std::vector<std::uint8_t> message(input.begin(), input.end());
    std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8u;
    message.push_back(0x80);
    while (message.size() % 64 != 56) {
        message.push_back(0);
    }
    for (int i = 7; i >= 0; --i) {
        message.push_back(static_cast<std::uint8_t>((bit_length >> (i * 8)) & 0xff));
    }

    std::uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                          0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};

    auto rotr = [](std::uint32_t value, int bits) {
        return (value >> bits) | (value << (32 - bits));
    };

    for (std::size_t offset = 0; offset < message.size(); offset += 64) {
        std::uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            std::size_t p = offset + static_cast<std::size_t>(i) * 4;
            w[i] = (static_cast<std::uint32_t>(message[p]) << 24) |
                   (static_cast<std::uint32_t>(message[p + 1]) << 16) |
                   (static_cast<std::uint32_t>(message[p + 2]) << 8) |
                   static_cast<std::uint32_t>(message[p + 3]);
        }
        for (int i = 16; i < 64; ++i) {
            std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^
                               (w[i - 15] >> 3);
            std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^
                               (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        std::uint32_t a = h[0];
        std::uint32_t b = h[1];
        std::uint32_t c = h[2];
        std::uint32_t d = h[3];
        std::uint32_t e = h[4];
        std::uint32_t f = h[5];
        std::uint32_t g = h[6];
        std::uint32_t hh = h[7];
        for (int i = 0; i < 64; ++i) {
            std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            std::uint32_t ch = (e & f) ^ (~e & g);
            std::uint32_t temp1 = hh + s1 + ch + kK[i] + w[i];
            std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            std::uint32_t temp2 = s0 + maj;
            hh = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }

    std::array<std::uint8_t, 32> digest{};
    for (int i = 0; i < 8; ++i) {
        for (int j = 0; j < 4; ++j) {
            digest[static_cast<std::size_t>(i) * 4 + static_cast<std::size_t>(j)] =
                static_cast<std::uint8_t>((h[i] >> ((3 - j) * 8)) & 0xff);
        }
    }
    return digest;
}

std::optional<std::string> normalize_algorithm(std::string_view algorithm) {
    std::string alg = lower_ascii(trim_view(algorithm));
    if (alg == "sha-1") {
        alg = "sha1";
    } else if (alg == "sha-256") {
        alg = "sha256";
    }
    if (alg == "sha1" || alg == "sha256" || alg == "md5") {
        return alg;
    }
    return std::nullopt;
}

std::vector<std::uint8_t> digest_bytes(std::string_view algorithm,
                                       std::string_view data) {
    if (algorithm == "sha1") {
        auto digest = sha1_bytes(data);
        return std::vector<std::uint8_t>(digest.begin(), digest.end());
    }
    if (algorithm == "sha256") {
        auto digest = sha256_bytes(data);
        return std::vector<std::uint8_t>(digest.begin(), digest.end());
    }
    auto digest = md5_bytes(data);
    return std::vector<std::uint8_t>(digest.begin(), digest.end());
}

std::size_t digest_size(std::string_view algorithm) {
    if (algorithm == "sha1") {
        return 20;
    }
    if (algorithm == "sha256") {
        return 32;
    }
    return 16;
}

std::optional<std::string> decode_digest_value(std::string_view encoded,
                                               std::string_view algorithm) {
    encoded = trim_view(encoded);
    std::size_t expected = digest_size(algorithm);
    if (encoded.empty()) {
        return std::nullopt;
    }
    // Hexadecimal is common in practice, although WARC specifies base32.
    if (encoded.size() == expected * 2) {
        if (auto decoded = decode_hex(encoded)) {
            return decoded;
        }
    }
    if (auto decoded = base32_decode(encoded)) {
        if (decoded->size() == expected) {
            return decoded;
        }
    }
    if (auto decoded = base32_decode(encoded, true)) {
        if (decoded->size() == expected) {
            return decoded;
        }
    }
    if (auto decoded = decode_hex(encoded)) {
        if (decoded->size() == expected) {
            return decoded;
        }
    }
    return std::nullopt;
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

bool looks_like_http_response(std::string_view body) {
    return starts_with_ci(body, "HTTP/");
}

bool looks_like_http_request(std::string_view body) {
    std::size_t space = body.find(' ');
    if (space == std::string_view::npos || space == 0 || space > 16) {
        return false;
    }
    for (std::size_t i = 0; i < space; ++i) {
        unsigned char c = static_cast<unsigned char>(body[i]);
        if (!(std::isupper(c) || c == '-' || c == '_' || std::isdigit(c))) {
            return false;
        }
    }
    return body.find(" HTTP/", space) != std::string_view::npos;
}

std::size_t http_header_end(std::string_view body) {
    std::size_t crlf = body.find("\r\n\r\n");
    std::size_t lf = body.find("\n\n");
    if (crlf != std::string_view::npos && (lf == std::string_view::npos || crlf <= lf)) {
        return crlf + 4;
    }
    if (lf != std::string_view::npos) {
        return lf + 2;
    }
    return std::string_view::npos;
}

std::string extract_payload(std::string_view type, std::string_view body,
                            std::string_view content_type,
                            bool* unterminated_http = nullptr) {
    if (unterminated_http != nullptr) {
        *unterminated_http = false;
    }
    std::string lower_type = lower_ascii(type);
    std::string lower_ct = lower_ascii(content_type);
    bool declares_http = lower_ct.find("application/http") != std::string::npos;
    bool looks_http = false;
    if (lower_type == "response" || lower_type == "revisit" ||
        lower_type == "conversion") {
        looks_http = looks_like_http_response(body);
    } else if (lower_type == "request") {
        looks_http = looks_like_http_request(body);
    }

    if (!declares_http && !looks_http) {
        return std::string(body);
    }
    if (body.empty()) {
        return {};
    }
    std::size_t end = http_header_end(body);
    if (end == std::string_view::npos) {
        if (unterminated_http != nullptr) {
            *unterminated_http = true;
        }
        return {};
    }
    return std::string(body.substr(end));
}

bool same_timestamp(std::string_view a, std::string_view b) {
    a = trim_view(a);
    b = trim_view(b);
    if (a.empty() || b.empty()) {
        return a.empty() && b.empty();
    }
    // Compare at second precision.  This accepts the common Z / +00:00
    // spellings without depending on a platform-specific timezone function.
    if (a.size() >= 19 && b.size() >= 19) {
        return a.substr(0, 19) == b.substr(0, 19);
    }
    return a == b;
}

std::vector<std::string> parse_id_list(std::string_view value) {
    std::vector<std::string> ids;
    value = trim_view(value);
    std::size_t pos = 0;
    while (pos < value.size()) {
        while (pos < value.size() &&
               (is_space(static_cast<unsigned char>(value[pos])) ||
                value[pos] == ',')) {
            ++pos;
        }
        if (pos >= value.size()) {
            break;
        }
        if (value[pos] == '<') {
            std::size_t close = value.find('>', pos + 1);
            if (close == std::string_view::npos) {
                std::string trailing = trim_copy(value.substr(pos + 1));
                if (!trailing.empty()) {
                    ids.push_back(std::move(trailing));
                }
                break;
            }
            std::string id = trim_copy(value.substr(pos + 1, close - pos - 1));
            if (!id.empty()) {
                ids.push_back(std::move(id));
            }
            pos = close + 1;
        } else {
            std::size_t end = pos;
            while (end < value.size() &&
                   !is_space(static_cast<unsigned char>(value[end])) &&
                   value[end] != ',' && value[end] != '<') {
                ++end;
            }
            if (end > pos) {
                ids.emplace_back(value.substr(pos, end - pos));
            }
            pos = end;
        }
    }
    return ids;
}

Diagnostic make_diagnostic(Severity severity, std::string code,
                           std::string message, std::string record_id = {},
                           std::string related_id = {},
                           std::optional<std::size_t> record_index = std::nullopt,
                           bool repairable = false) {
    Diagnostic diagnostic;
    diagnostic.severity = severity;
    diagnostic.code = std::move(code);
    diagnostic.message = std::move(message);
    diagnostic.record_id = std::move(record_id);
    diagnostic.related_id = std::move(related_id);
    diagnostic.record_index = record_index;
    diagnostic.repairable = repairable;
    return diagnostic;
}

RepairAction make_repair(std::string code, std::string record_id,
                         std::string missing_id, std::string action,
                         std::string detail) {
    RepairAction repair;
    repair.code = std::move(code);
    repair.record_id = std::move(record_id);
    repair.missing_id = std::move(missing_id);
    repair.action = std::move(action);
    repair.detail = std::move(detail);
    return repair;
}

}  // namespace

// ---------------------------------------------------------------------------
// Record accessors
// ---------------------------------------------------------------------------

std::string_view to_string(Severity severity) {
    switch (severity) {
        case Severity::info:
            return "info";
        case Severity::warning:
            return "warning";
        case Severity::error:
            return "error";
    }
    return "error";
}

std::string Record::header(std::string_view name) const {
    for (const Field& field : fields) {
        if (iequals(field.name, name)) {
            return field.value;
        }
    }
    return {};
}

std::vector<std::string> Record::headers(std::string_view name) const {
    std::vector<std::string> values;
    for (const Field& field : fields) {
        if (iequals(field.name, name)) {
            values.push_back(field.value);
        }
    }
    return values;
}

bool Record::has_header(std::string_view name) const {
    for (const Field& field : fields) {
        if (iequals(field.name, name)) {
            return true;
        }
    }
    return false;
}

std::string Record::type() const {
    return lower_ascii(trim_view(header("WARC-Type")));
}

std::string Record::raw_id() const {
    return trim_copy(header("WARC-Record-ID"));
}

std::string Record::id() const {
    return normalize_record_id(raw_id());
}

std::string Record::date() const {
    return trim_copy(header("WARC-Date"));
}

std::string Record::target_uri() const {
    return trim_copy(header("WARC-Target-URI"));
}

std::string Record::content_type() const {
    return trim_copy(header("Content-Type"));
}

std::optional<std::uint64_t> Record::content_length() const {
    return parse_uint(header("Content-Length"));
}

std::optional<std::uint64_t> Record::segment_number() const {
    return parse_uint(header("WARC-Segment-Number"));
}

std::string Record::segment_origin_id() const {
    return normalize_record_id(header("WARC-Segment-Origin-ID"));
}

std::optional<std::uint64_t> Record::segment_total_length() const {
    return parse_uint(header("WARC-Segment-Total-Length"));
}

std::vector<std::string> Record::concurrent_to() const {
    return headers("WARC-Concurrent-To");
}

std::string Record::refers_to() const {
    return normalize_record_id(header("WARC-Refers-To"));
}

std::string Record::refers_to_target_uri() const {
    return trim_copy(header("WARC-Refers-To-Target-URI"));
}

std::string Record::refers_to_date() const {
    return trim_copy(header("WARC-Refers-To-Date"));
}

std::string Record::profile() const {
    return trim_copy(header("WARC-Profile"));
}

bool Record::is_segment_continuation() const {
    if (type() == "continuation") {
        return true;
    }
    if (auto number = segment_number(); number && *number > 1) {
        return true;
    }
    std::string origin = segment_origin_id();
    return !origin.empty() && origin != id();
}

std::string normalize_record_id(std::string_view id) {
    std::string value(trim_view(id));
    if (value.size() >= 2 && value.front() == '<' && value.back() == '>') {
        value = trim_copy(std::string_view(value).substr(1, value.size() - 2));
    }
    if (starts_with_ci(value, "urn:uuid:")) {
        value = lower_ascii(value);
    }
    return value;
}

bool same_record_id(std::string_view a, std::string_view b) {
    return normalize_record_id(a) == normalize_record_id(b);
}

// ---------------------------------------------------------------------------
// Digest public API
// ---------------------------------------------------------------------------

std::string digest_hex(std::string_view algorithm, std::string_view data) {
    auto normalized = normalize_algorithm(algorithm);
    if (!normalized) {
        return {};
    }
    std::vector<std::uint8_t> bytes = digest_bytes(*normalized, data);
    return bytes_to_hex(bytes.data(), bytes.size());
}

std::string digest_base32(std::string_view algorithm, std::string_view data) {
    auto normalized = normalize_algorithm(algorithm);
    if (!normalized) {
        return {};
    }
    std::vector<std::uint8_t> bytes = digest_bytes(*normalized, data);
    return base32_encode(bytes.data(), bytes.size());
}

std::vector<DigestValue> parse_digest_values(std::string_view value,
                                             std::string* error) {
    std::vector<DigestValue> values;
    if (error != nullptr) {
        error->clear();
    }
    std::size_t start = 0;
    while (start <= value.size()) {
        std::size_t comma = value.find(',', start);
        std::string_view piece = value.substr(
            start, comma == std::string_view::npos ? std::string_view::npos
                                                   : comma - start);
        piece = trim_view(piece);
        if (!piece.empty()) {
            std::size_t colon = piece.find(':');
            if (colon == std::string_view::npos) {
                if (error != nullptr) {
                    *error = "digest value has no algorithm prefix";
                }
                return {};
            }
            auto algorithm = normalize_algorithm(piece.substr(0, colon));
            if (!algorithm) {
                if (error != nullptr) {
                    *error = "unsupported digest algorithm: " +
                             std::string(trim_view(piece.substr(0, colon)));
                }
                return {};
            }
            auto decoded = decode_digest_value(piece.substr(colon + 1), *algorithm);
            if (!decoded) {
                if (error != nullptr) {
                    *error = "invalid " + *algorithm + " digest encoding";
                }
                return {};
            }
            values.push_back(DigestValue{
                *algorithm,
                bytes_to_hex(reinterpret_cast<const std::uint8_t*>(decoded->data()),
                             decoded->size())});
        }
        if (comma == std::string_view::npos) {
            break;
        }
        start = comma + 1;
    }
    if (values.empty() && error != nullptr && error->empty()) {
        *error = "empty digest value";
    }
    return values;
}

bool verify_digest(std::string_view value, std::string_view data,
                   DigestValue* matched, std::string* error) {
    std::vector<DigestValue> values = parse_digest_values(value, error);
    for (const DigestValue& candidate : values) {
        std::string actual = digest_hex(candidate.algorithm, data);
        if (actual == candidate.hex) {
            if (matched != nullptr) {
                *matched = candidate;
            }
            if (error != nullptr) {
                error->clear();
            }
            return true;
        }
    }
    if (error != nullptr && error->empty() && !values.empty()) {
        *error = "digest does not match data";
    }
    return false;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

namespace {

struct LineResult {
    bool ok = false;
    bool had_newline = false;
    bool crlf = false;
    std::string_view line;
};

LineResult read_line(std::string_view data, std::size_t& pos) {
    LineResult result;
    if (pos >= data.size()) {
        return result;
    }
    result.ok = true;
    std::size_t newline = data.find('\n', pos);
    std::size_t end = newline == std::string_view::npos ? data.size() : newline;
    result.had_newline = newline != std::string_view::npos;
    std::size_t content_end = end;
    if (content_end > pos && data[content_end - 1] == '\r') {
        result.crlf = true;
        --content_end;
    }
    result.line = data.substr(pos, content_end - pos);
    pos = newline == std::string_view::npos ? data.size() : newline + 1;
    return result;
}

std::size_t find_next_record(std::string_view data, std::size_t from) {
    for (std::size_t i = from; i + 5 <= data.size(); ++i) {
        bool at_line_start = i == 0 || data[i - 1] == '\n';
        if (at_line_start && data.compare(i, 5, "WARC/") == 0) {
            return i;
        }
    }
    return std::string_view::npos;
}

bool only_whitespace(std::string_view data, std::size_t from) {
    for (std::size_t i = from; i < data.size(); ++i) {
        if (!is_space(static_cast<unsigned char>(data[i]))) {
            return false;
        }
    }
    return true;
}

}  // namespace

ParseResult parse_warc(std::string_view data, const ParseOptions& options) {
    ParseResult result;
    std::size_t pos = 0;
    if (data.size() >= 3 &&
        static_cast<unsigned char>(data[0]) == 0xef &&
        static_cast<unsigned char>(data[1]) == 0xbb &&
        static_cast<unsigned char>(data[2]) == 0xbf) {
        pos = 3;
        result.diagnostics.push_back(make_diagnostic(
            Severity::warning, "utf8_bom", "input starts with a UTF-8 byte order mark"));
    }

    while (pos < data.size()) {
        if (only_whitespace(data, pos)) {
            break;
        }
        // Tolerate blank lines left between records by streaming producers.
        while (pos < data.size() &&
               (data[pos] == '\r' || data[pos] == '\n' || data[pos] == ' ' ||
                data[pos] == '\t')) {
            ++pos;
        }
        if (pos >= data.size()) {
            break;
        }
        if (data.compare(pos, 5, "WARC/") != 0) {
            std::size_t next = find_next_record(data, pos);
            if (next == std::string_view::npos) {
                result.diagnostics.push_back(make_diagnostic(
                    Severity::error, "trailing_data",
                    "bytes after the last WARC record are not a WARC record",
                    {}, {}, std::nullopt, true));
                break;
            }
            result.diagnostics.push_back(make_diagnostic(
                Severity::error, "leading_data",
                "skipped bytes before the next WARC record", {}, {}, std::nullopt,
                false));
            pos = next;
        }

        std::size_t record_offset = pos;
        Record record;
        record.offset = record_offset;
        record.index = result.records.size();
        std::vector<Diagnostic> local_diagnostics;
        auto add_local = [&](Severity severity, std::string code,
                             std::string message, bool repairable = false) {
            local_diagnostics.push_back(make_diagnostic(
                severity, std::move(code), std::move(message), {}, {},
                record.index, repairable));
        };

        LineResult version_line = read_line(data, pos);
        if (!version_line.ok) {
            break;
        }
        std::string_view version = trim_view(version_line.line);
        if (!version.starts_with("WARC/")) {
            add_local(Severity::error, "invalid_version_line",
                      "record does not start with a WARC version line", true);
            record.malformed = true;
        }
        record.version = std::string(version);
        if (version != "WARC/1.0" && version != "WARC/1.1") {
            add_local(Severity::warning, "unknown_warc_version",
                      "unrecognized WARC version: " + record.version);
        }
        if (version_line.had_newline && !version_line.crlf &&
            !options.tolerate_lf_line_endings) {
            add_local(Severity::error, "non_crlf_line_ending",
                      "WARC lines must end with CRLF", true);
        }

        bool header_end = false;
        while (pos < data.size()) {
            LineResult line_result = read_line(data, pos);
            if (!line_result.ok) {
                break;
            }
            if (line_result.had_newline && !line_result.crlf &&
                !options.tolerate_lf_line_endings) {
                add_local(Severity::error, "non_crlf_line_ending",
                          "WARC header line does not end with CRLF", true);
            }
            if (line_result.line.empty()) {
                header_end = true;
                break;
            }
            if (line_result.line.front() == ' ' || line_result.line.front() == '\t') {
                if (record.fields.empty()) {
                    add_local(Severity::error, "orphan_header_continuation",
                              "header continuation has no preceding field", true);
                    record.malformed = true;
                } else {
                    record.fields.back().value.push_back(' ');
                    record.fields.back().value.append(trim_view(line_result.line));
                }
                continue;
            }
            std::size_t colon = line_result.line.find(':');
            if (colon == std::string_view::npos) {
                add_local(Severity::error, "malformed_header",
                          "WARC header line has no colon", true);
                record.malformed = true;
                continue;
            }
            Field field;
            field.name = trim_copy(line_result.line.substr(0, colon));
            field.value = trim_copy(line_result.line.substr(colon + 1));
            if (field.name.empty()) {
                add_local(Severity::error, "malformed_header",
                          "WARC header has an empty field name", true);
                record.malformed = true;
                continue;
            }
            record.fields.push_back(std::move(field));
        }
        if (!header_end) {
            add_local(Severity::error, "missing_header_terminator",
                      "record headers are not terminated by a blank line", true);
            record.malformed = true;
            record.body.clear();
            pos = data.size();
        } else {
            std::size_t body_start = pos;
            std::vector<std::string> length_values = record.headers("Content-Length");
            std::optional<std::uint64_t> content_length;
            bool length_valid = true;
            bool separator_already_consumed = false;
            if (length_values.empty()) {
                add_local(Severity::error, "missing_content_length",
                          "record has no Content-Length header", true);
                record.malformed = true;
                length_valid = false;
            } else {
                content_length = parse_uint(length_values.front());
                if (!content_length) {
                    add_local(Severity::error, "invalid_content_length",
                              "Content-Length is not a non-negative integer", true);
                    record.malformed = true;
                    length_valid = false;
                }
                for (std::size_t i = 1; i < length_values.size(); ++i) {
                    auto other = parse_uint(length_values[i]);
                    if (!other || !content_length || *other != *content_length) {
                        add_local(Severity::error, "conflicting_content_length",
                                  "record has conflicting Content-Length values",
                                  true);
                        record.malformed = true;
                        length_valid = false;
                    }
                }
            }

            if (!length_valid) {
                // Without a trustworthy length, recover at the next record
                // boundary.  The recovered body is diagnostic only.
                std::size_t next = find_next_record(data, body_start);
                std::size_t body_end = next == std::string_view::npos ? data.size()
                                                                     : next;
                while (body_end > body_start) {
                    if (body_end >= body_start + 4 &&
                        data.substr(body_end - 4, 4) == "\r\n\r\n") {
                        body_end -= 4;
                        break;
                    }
                    if (body_end >= body_start + 2 &&
                        data.substr(body_end - 2, 2) == "\n\n") {
                        body_end -= 2;
                        break;
                    }
                    break;
                }
                record.body = std::string(data.substr(body_start, body_end - body_start));
                pos = next == std::string_view::npos ? data.size() : next;
                separator_already_consumed = true;
            } else {
                std::uint64_t length = *content_length;
                std::size_t available = data.size() - body_start;
                if (length > available) {
                    record.truncated = true;
                    record.body = std::string(data.substr(body_start));
                    pos = data.size();
                    add_local(Severity::error, "content_length_mismatch",
                              "Content-Length is " + std::to_string(length) +
                                  " but only " + std::to_string(available) +
                                  " bytes are available",
                              true);
                } else {
                    record.body = std::string(
                        data.substr(body_start, static_cast<std::size_t>(length)));
                    pos = body_start + static_cast<std::size_t>(length);
                }
            }

            if (!record.truncated && !separator_already_consumed) {
                if (pos >= data.size()) {
                    add_local(options.strict_record_separator ? Severity::error
                                                              : Severity::warning,
                              "missing_record_separator",
                              "record is not followed by CRLFCRLF", true);
                } else if (data.compare(pos, 4, "\r\n\r\n") == 0) {
                    pos += 4;
                } else if (data.compare(pos, 2, "\n\n") == 0) {
                    if (!options.tolerate_lf_line_endings) {
                        add_local(Severity::error, "non_crlf_line_ending",
                                  "record separator is not CRLFCRLF", true);
                    }
                    pos += 2;
                } else if (data.compare(pos, 2, "\r\n") == 0) {
                    pos += 2;
                    add_local(Severity::warning, "missing_record_separator",
                              "record has only one CRLF after its body", true);
                } else if (data[pos] == '\n') {
                    ++pos;
                    add_local(Severity::warning, "missing_record_separator",
                              "record has only one LF after its body", true);
                } else {
                    add_local(Severity::error, "invalid_record_separator",
                              "record body is not followed by CRLFCRLF", true);
                    record.malformed = true;
                    if (options.recover_after_errors) {
                        std::size_t next = find_next_record(data, pos);
                        pos = next == std::string_view::npos ? data.size() : next;
                    }
                }
            }
        }

        std::string record_id = record.id();
        for (Diagnostic& diagnostic : local_diagnostics) {
            diagnostic.record_id = record_id;
            result.diagnostics.push_back(std::move(diagnostic));
        }
        result.records.push_back(std::move(record));
    }

    return result;
}

ParseResult parse_warc_stream(std::istream& input, const ParseOptions& options) {
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return parse_warc(buffer.str(), options);
}

bool ParseResult::ok() const {
    for (const Diagnostic& diagnostic : diagnostics) {
        if (diagnostic.severity == Severity::error) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

Assembly assemble(std::vector<Record> records, const AssembleOptions& options) {
    Assembly assembly;
    assembly.records = std::move(records);
    const std::vector<Record>& recs = assembly.records;
    const std::size_t record_count = recs.size();
    std::vector<bool> record_error(record_count, false);

    auto record_label = [&](std::size_t index) {
        std::string id = recs[index].id();
        if (!id.empty()) {
            return id;
        }
        return std::string("<stream-index:") + std::to_string(index) + ">";
    };

    auto add_global = [&](Severity severity, std::string code, std::string message,
                          std::optional<std::size_t> record_index,
                          std::string related_id, bool repairable,
                          RepairAction repair = {}) {
        std::string record_id =
            record_index && *record_index < recs.size() ? recs[*record_index].id()
                                                        : std::string();
        if (severity == Severity::error && record_index &&
            *record_index < record_error.size()) {
            record_error[*record_index] = true;
        }
        assembly.diagnostics.push_back(make_diagnostic(
            severity, std::move(code), std::move(message), std::move(record_id),
            std::move(related_id), record_index, repairable));
        if (repairable) {
            assembly.repairs.push_back(std::move(repair));
        }
    };

    std::unordered_map<std::string, std::vector<std::size_t>> all_by_id;
    std::unordered_map<std::string, std::vector<std::size_t>> heads_by_id;
    std::vector<bool> head(record_count, true);

    for (std::size_t i = 0; i < record_count; ++i) {
        const Record& record = recs[i];
        std::string id = record.id();
        if (id.empty()) {
            add_global(
                Severity::error, "missing_record_id",
                "WARC record has no WARC-Record-ID", i, {}, true,
                make_repair(
                    "missing_record_id", record_label(i), {},
                    "Assign a unique WARC-Record-ID to the record at stream index " +
                        std::to_string(i) + ".",
                    "The record cannot participate in reliable id/concurrent-to "
                    "pairing without an identity."));
        } else {
            all_by_id[id].push_back(i);
        }

        std::string type = record.type();
        if (type.empty()) {
            add_global(
                Severity::error, "missing_warc_type",
                "WARC record has no WARC-Type", i, {}, true,
                make_repair("missing_warc_type", record_label(i), {},
                            "Add a WARC-Type to the record at stream index " +
                                std::to_string(i) + ".",
                            "Assembly cannot classify a record without its type."));
        }
        if (record.date().empty()) {
            add_global(Severity::warning, "missing_warc_date",
                       "WARC record has no WARC-Date", i, {}, false);
        }
        if (!record.version.empty() && record.version != "WARC/1.0" &&
            record.version != "WARC/1.1") {
            add_global(Severity::warning, "unknown_warc_version",
                       "record uses an unrecognized WARC version: " + record.version,
                       i, {}, false);
        }

        if (!record.has_header("Content-Length")) {
            add_global(
                Severity::error, "missing_content_length",
                "WARC record has no Content-Length", i, {}, true,
                make_repair("missing_content_length", record_label(i), {},
                            "Recover the original Content-Length for the record at "
                            "stream index " +
                                std::to_string(i) + ".",
                            "The body boundary cannot be verified without a length."));
        } else {
            auto length = record.content_length();
            if (!length) {
                add_global(
                    Severity::error, "invalid_content_length",
                    "Content-Length is not a non-negative decimal integer", i, {},
                    true,
                    make_repair("invalid_content_length", record_label(i), {},
                                "Repair the Content-Length header of the record at "
                                "stream index " +
                                    std::to_string(i) + ".",
                                "A valid length is required to delimit the block."));
            } else if (*length != record.body.size()) {
                add_global(
                    Severity::error, "content_length_mismatch",
                    "Content-Length is " + std::to_string(*length) +
                        " but the parsed body has " +
                        std::to_string(record.body.size()) + " bytes",
                    i, {}, true,
                    make_repair(
                        "content_length_mismatch", record_label(i), {},
                        "Re-export or re-fetch the record at stream index " +
                            std::to_string(i) +
                            "; its Content-Length and block length disagree.",
                        "The physical record is truncated or the header is wrong."));
            }
        }

        if (record.truncated) {
            add_global(
                Severity::error, "truncated_record",
                "record body ends before Content-Length bytes were read", i, {},
                true,
                make_repair("truncated_record", record_label(i), {},
                            "Re-fetch the missing bytes of the record at stream index " +
                                std::to_string(i) +
                                ", or retain it as an explicitly truncated record.",
                            "A truncated block cannot be treated as a complete payload."));
        }
        if (record.malformed) {
            add_global(
                Severity::error, "malformed_record",
                "record has malformed headers or delimiters", i, {}, true,
                make_repair("malformed_record", record_label(i), {},
                            "Repair the WARC framing of the record at stream index " +
                                std::to_string(i) + ".",
                            "Header/body framing must be reliable before assembly."));
        }

        bool segment_header = record.has_header("WARC-Segment-Number");
        auto number = record.segment_number();
        if (segment_header && !number) {
            add_global(
                Severity::error, "invalid_segment_number",
                "WARC-Segment-Number is not a positive integer", i, {}, true,
                make_repair("invalid_segment_number", record_label(i), {},
                            "Repair WARC-Segment-Number on the record at stream index " +
                                std::to_string(i) + ".",
                            "Segments are ordered by this number."));
        }

        std::string origin = record.segment_origin_id();
        bool is_head = true;
        if (type == "continuation") {
            if (number && *number == 1 && !origin.empty() && origin == id) {
                add_global(
                    Severity::warning, "continuation_number_one",
                    "WARC-Type continuation is marked as segment 1; treating it as "
                    "the first segment",
                    i, {}, false);
                is_head = true;
            } else {
                is_head = false;
            }
        } else if (number) {
            if (*number == 0) {
                add_global(
                    Severity::error, "invalid_segment_number",
                    "WARC-Segment-Number must start at 1", i, {}, true,
                    make_repair("invalid_segment_number", record_label(i), {},
                                "Correct WARC-Segment-Number on the record at stream "
                                "index " +
                                    std::to_string(i) + ".",
                                "Segment numbers start at 1."));
                is_head = false;
            } else if (*number > 1) {
                is_head = false;
            } else if (!origin.empty() && origin != id) {
                is_head = false;
            }
        } else if (!origin.empty() && origin != id) {
            is_head = false;
        }
        head[i] = is_head;

        if (is_head) {
            if (!id.empty()) {
                heads_by_id[id].push_back(i);
            }
        }
    }

    for (const auto& [id, indexes] : all_by_id) {
        if (indexes.size() <= 1) {
            continue;
        }
        for (std::size_t index : indexes) {
            record_error[index] = true;
        }
        for (std::size_t k = 1; k < indexes.size(); ++k) {
            std::size_t index = indexes[k];
            add_global(
                Severity::error, "duplicate_record_id",
                "WARC-Record-ID occurs on more than one record", index, id, true,
                make_repair(
                    "duplicate_record_id", record_label(index), id,
                    "Deduplicate the records sharing WARC-Record-ID " + id +
                        "; keep the intended unique record and re-export the other "
                        "with a new id.",
                    "A duplicate id makes every id-based reference ambiguous."));
        }
    }

    std::unordered_map<std::string, std::size_t> unique_head;
    for (const auto& [id, indexes] : heads_by_id) {
        if (indexes.size() == 1) {
            unique_head[id] = indexes.front();
        }
    }

    std::vector<std::string> segment_origin(record_count);
    for (std::size_t i = 0; i < record_count; ++i) {
        segment_origin[i] = recs[i].segment_origin_id();
    }
    // WARC-Segment-Origin-ID is the standard continuation link.  Some
    // producers instead put the first segment id in WARC-Concurrent-To; accept
    // that only when it names exactly one unique head, and report the fallback.
    for (std::size_t i = 0; i < record_count; ++i) {
        if (head[i] || !segment_origin[i].empty()) {
            continue;
        }
        std::set<std::string> references;
        for (const std::string& value : recs[i].concurrent_to()) {
            for (const std::string& raw : parse_id_list(value)) {
                std::string id = normalize_record_id(raw);
                if (!id.empty()) {
                    references.insert(id);
                }
            }
        }
        std::vector<std::string> head_references;
        for (const std::string& reference : references) {
            if (unique_head.count(reference)) {
                head_references.push_back(reference);
            }
        }
        if (references.size() == 1 && head_references.size() == 1) {
            segment_origin[i] = head_references.front();
            add_global(
                Severity::warning, "continuation_origin_from_concurrent_to",
                "continuation has no WARC-Segment-Origin-ID; using its "
                "WARC-Concurrent-To reference as the origin",
                i, segment_origin[i], true,
                make_repair(
                    "continuation_origin_from_concurrent_to", record_label(i),
                    segment_origin[i],
                    "Add WARC-Segment-Origin-ID: <" + segment_origin[i] +
                        "> to the continuation.",
                    "The record was attached using WARC-Concurrent-To, which is a "
                    "compatibility fallback rather than the standard segment "
                    "origin field."));
        } else {
            add_global(
                Severity::error, "continuation_missing_origin",
                "continuation record has no WARC-Segment-Origin-ID", i, {}, true,
                make_repair(
                    "continuation_missing_origin", record_label(i), {},
                    "Add WARC-Segment-Origin-ID pointing to the first segment of this "
                    "record, or move the segment into its original record.",
                    "A continuation cannot be attached without an unambiguous "
                    "origin id."));
        }
    }

    // Group physical records into logical records.  A group key is the unique
    // head id when available.  Duplicate heads and orphan continuations get
    // private grouping keys and never masquerade as a known record.
    std::unordered_map<std::string, std::vector<std::size_t>> groups;
    for (std::size_t i = 0; i < record_count; ++i) {
        const Record& record = recs[i];
        std::string id = record.id();
        std::string key;
        if (head[i]) {
            if (!id.empty() && unique_head.count(id) && unique_head[id] == i) {
                key = "id:" + id;
            } else {
                key = "head:" + std::to_string(i);
            }
        } else {
            const std::string& origin = segment_origin[i];
            if (!origin.empty() && unique_head.count(origin)) {
                key = "id:" + origin;
            } else if (!origin.empty()) {
                key = "orphan:" + origin;
            } else {
                key = "orphan-segment:" + std::to_string(i);
            }
        }
        groups[key].push_back(i);
    }

    std::vector<std::string> group_keys;
    group_keys.reserve(groups.size());
    for (const auto& entry : groups) {
        group_keys.push_back(entry.first);
    }
    std::sort(group_keys.begin(), group_keys.end(),
              [&](const std::string& a, const std::string& b) {
                  const auto& ga = groups[a];
                  const auto& gb = groups[b];
                  std::size_t ma = *std::min_element(ga.begin(), ga.end());
                  std::size_t mb = *std::min_element(gb.begin(), gb.end());
                  return ma < mb;
              });

    std::vector<std::vector<MissingLink>> logical_missing;
    std::vector<std::vector<RepairAction>> logical_repairs;

    auto add_logical_issue = [&](std::vector<Diagnostic>& diagnostics,
                                 bool& complete, Severity severity,
                                 std::string code, std::string message,
                                 std::size_t source_index,
                                 std::string related_id = {}) {
        Diagnostic diagnostic = make_diagnostic(
            severity, std::move(code), std::move(message),
            recs[source_index].id(), std::move(related_id), source_index,
            severity == Severity::error);
        if (severity == Severity::error) {
            complete = false;
        }
        diagnostics.push_back(std::move(diagnostic));
    };

    for (const std::string& key : group_keys) {
        const std::vector<std::size_t>& members = groups[key];
        LogicalRecord logical;
        bool group_complete = true;
        for (std::size_t member : members) {
            if (record_error[member]) {
                group_complete = false;
            }
        }
        std::vector<MissingLink> pending_missing;
        std::vector<RepairAction> pending_repairs;
        auto add_local_repair = [&](std::string code, std::string missing_id,
                                    std::string action, std::string detail) {
            RepairAction repair = make_repair(
                std::move(code), logical.id, std::move(missing_id),
                std::move(action), std::move(detail));
            pending_repairs.push_back(repair);
            assembly.repairs.push_back(std::move(repair));
        };
        std::size_t head_index = record_count;
        if (key.rfind("id:", 0) == 0) {
            std::string id = key.substr(3);
            auto it = unique_head.find(id);
            if (it != unique_head.end()) {
                head_index = it->second;
            }
        } else if (key.rfind("head:", 0) == 0) {
            std::size_t parsed = 0;
            std::string_view tail = std::string_view(key).substr(5);
            auto conversion = std::from_chars(tail.data(), tail.data() + tail.size(),
                                              parsed);
            if (conversion.ec == std::errc{} &&
                conversion.ptr == tail.data() + tail.size()) {
                head_index = parsed;
            }
        }
        logical.has_head = head_index < record_count;
        logical.head_index = logical.has_head ? head_index : members.front();

        bool segmented = members.size() > 1;
        for (std::size_t index : members) {
            const Record& record = recs[index];
            if (record.is_segment_continuation()) {
                segmented = true;
            }
            const std::string& origin = segment_origin[index];
            if (!origin.empty() &&
                (origin != record.id() || members.size() > 1)) {
                segmented = true;
            }
            if (auto number = record.segment_number(); number && *number > 1) {
                segmented = true;
            }
        }
        logical.segmented = segmented;

        std::size_t first_index = members.front();
        if (logical.has_head) {
            logical.id = recs[head_index].id();
            logical.origin_id = segment_origin[head_index];
            logical.type = recs[head_index].type();
            logical.target_uri = recs[head_index].target_uri();
            logical.date = recs[head_index].date();
            if (recs[head_index].has_header("WARC-Truncated")) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "record_marked_truncated",
                    "record declares WARC-Truncated and is not a complete capture",
                    head_index, logical.id);
                add_local_repair(
                    "record_marked_truncated", {},
                    "Re-fetch the missing part of record " + logical.id +
                        " if a complete payload is required.",
                    "WARC-Truncated explicitly marks the capture as incomplete.");
            }
        } else {
            std::size_t earliest = members.front();
            for (std::size_t index : members) {
                if (index < earliest) {
                    earliest = index;
                }
            }
            first_index = earliest;
            logical.id = recs[earliest].id();
            logical.type = recs[earliest].type();
            logical.target_uri = recs[earliest].target_uri();
            logical.date = recs[earliest].date();
            if (key.rfind("orphan:", 0) == 0) {
                logical.origin_id = key.substr(7);
            } else {
                logical.origin_id = segment_origin[earliest];
            }
            add_logical_issue(
                logical.diagnostics, group_complete, Severity::error,
                "orphan_continuation",
                "continuation record has no available first segment",
                earliest, logical.origin_id);
            MissingLink missing;
            missing.kind = "segment_origin";
            missing.record_id = recs[earliest].id();
            missing.reference = logical.origin_id;
            missing.reason =
                "the first segment named by WARC-Segment-Origin-ID is absent";
            missing.record_index = earliest;
            pending_missing.push_back(missing);
            assembly.missing_links.push_back(missing);
            add_local_repair(
                "orphan_continuation", logical.origin_id,
                "Import the first segment with id " + logical.origin_id +
                    ", or move this continuation back into its original record.",
                "A segment body cannot be treated as a complete record without "
                "its first segment.");
        }

        struct OrderedSegment {
            std::size_t index = 0;
            std::uint64_t number = 0;
            bool has_number = false;
        };
        std::vector<OrderedSegment> ordered;
        ordered.reserve(members.size());
        for (std::size_t index : members) {
            OrderedSegment segment;
            segment.index = index;
            if (auto number = recs[index].segment_number()) {
                segment.number = *number;
                segment.has_number = true;
            }
            ordered.push_back(segment);
        }

        for (OrderedSegment& segment : ordered) {
            if (segment.has_number) {
                continue;
            }
            if (segment.index == head_index) {
                segment.number = 1;
                segment.has_number = true;
                if (segmented) {
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::warning,
                        "segment_number_missing",
                        "first segment has no WARC-Segment-Number; assuming 1",
                        segment.index, logical.id);
                }
            } else {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "segment_number_missing",
                    "continuation has no WARC-Segment-Number", segment.index,
                    logical.id);
                add_local_repair(
                    "segment_number_missing", {},
                    "Add WARC-Segment-Number to the continuation at stream index " +
                        std::to_string(segment.index) + ".",
                    "Continuation ordering and gap detection require the segment "
                    "number.");
            }
        }

        std::sort(ordered.begin(), ordered.end(),
                  [&](const OrderedSegment& a, const OrderedSegment& b) {
                      if (a.index == head_index) {
                          return b.index != head_index;
                      }
                      if (b.index == head_index) {
                          return false;
                      }
                      std::uint64_t an = a.has_number
                                             ? a.number
                                             : std::numeric_limits<std::uint64_t>::max();
                      std::uint64_t bn = b.has_number
                                             ? b.number
                                             : std::numeric_limits<std::uint64_t>::max();
                      if (an != bn) {
                          return an < bn;
                      }
                      return a.index < b.index;
                  });

        std::map<std::uint64_t, std::vector<std::size_t>> number_counts;
        for (std::size_t position = 0; position < ordered.size(); ++position) {
            const OrderedSegment& segment = ordered[position];
            const Record& record = recs[segment.index];
            logical.segments.push_back(
                SegmentRef{segment.index, segment.has_number ? segment.number : 0,
                           static_cast<std::uint64_t>(record.body.size())});
            logical.block.append(record.body);
            if (!segment.has_number) {
                continue;
            }
            if (segment.number == 0) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "invalid_segment_number", "segment number 0 is invalid",
                    segment.index, logical.id);
                add_local_repair(
                    "invalid_segment_number", {},
                    "Correct WARC-Segment-Number on the segment at stream index " +
                        std::to_string(segment.index) + ".",
                    "Segment numbers start at 1.");
                continue;
            }
            number_counts[segment.number].push_back(segment.index);
        }
        logical.total_length = logical.block.size();

        bool payload_unterminated = false;
        std::string content_type;
        if (logical.has_head) {
            content_type = recs[head_index].content_type();
        } else if (first_index < record_count) {
            content_type = recs[first_index].content_type();
        }
        logical.payload =
            extract_payload(logical.type, logical.block, content_type,
                            &payload_unterminated);
        if (payload_unterminated) {
            add_logical_issue(
                logical.diagnostics, group_complete, Severity::error,
                "http_headers_unterminated",
                "HTTP headers in the record block have no terminating blank line",
                logical.has_head ? head_index : first_index, logical.id);
            add_local_repair(
                "http_headers_unterminated", {},
                "Re-export record " + logical.id +
                    " with a complete HTTP header block terminated by CRLFCRLF.",
                "The payload boundary cannot be determined.");
        }

        if (logical.has_head && logical.segmented) {
            if (auto number = recs[head_index].segment_number();
                number && *number != 1) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "segment_head_not_first",
                    "first segment does not have WARC-Segment-Number: 1",
                    head_index, logical.id);
                add_local_repair(
                    "segment_head_not_first", {},
                    "Renumber the first segment of " + logical.id + " to 1.",
                    "Segment numbering must start at 1.");
            }
            for (const SegmentRef& segment : logical.segments) {
                if (segment.record_index == head_index) {
                    continue;
                }
                const std::string& origin = segment_origin[segment.record_index];
                if (origin.empty()) {
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::error,
                        "continuation_missing_origin",
                        "continuation has no WARC-Segment-Origin-ID",
                        segment.record_index, logical.id);
                    add_local_repair(
                        "continuation_missing_origin", {},
                        "Add WARC-Segment-Origin-ID: <" + logical.id +
                            "> to the continuation at stream index " +
                            std::to_string(segment.record_index) + ".",
                        "The continuation must identify its first segment.");
                } else if (origin != logical.id) {
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::error,
                        "segment_origin_mismatch",
                        "continuation points at a different first segment",
                        segment.record_index, origin);
                    add_local_repair(
                        "segment_origin_mismatch", origin,
                        "Correct WARC-Segment-Origin-ID on the continuation to "
                        "reference <" + logical.id + ">.",
                        "The continuation is grouped with a different first "
                        "segment.");
                }
            }
        }

        if (segmented) {
            for (const auto& entry : number_counts) {
                if (entry.second.size() > 1) {
                    for (std::size_t k = 1; k < entry.second.size(); ++k) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::error,
                            "duplicate_segment_number",
                            "more than one segment uses WARC-Segment-Number " +
                                std::to_string(entry.first),
                            entry.second[k], logical.id);
                        add_local_repair(
                            "duplicate_segment_number",
                            std::to_string(entry.first),
                            "Renumber the duplicate segment at stream index " +
                                std::to_string(entry.second[k]) + ".",
                            "Each segment number must occur once.");
                    }
                }
            }
            std::uint64_t expected_count =
                static_cast<std::uint64_t>(ordered.size());
            for (std::uint64_t number = 1; number <= expected_count; ++number) {
                if (!number_counts.count(number)) {
                    MissingLink missing;
                    missing.kind = "segment";
                    missing.record_id = logical.id;
                    missing.reference = std::to_string(number);
                    missing.reason = "segment " + std::to_string(number) +
                                     " of the record is missing";
                    missing.record_index = logical.head_index;
                    pending_missing.push_back(missing);
                    assembly.missing_links.push_back(missing);
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::error,
                        "missing_segment", missing.reason, logical.head_index,
                        logical.id);
                    add_local_repair(
                        "missing_segment", std::to_string(number),
                        "Import WARC-Segment-Number " + std::to_string(number) +
                            " of record " + logical.id +
                            " before treating the body as complete.",
                        "The remaining segments do not form the full logical "
                        "record.");
                }
            }
            for (const auto& entry : number_counts) {
                if (entry.first > expected_count) {
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::error,
                        "segment_number_out_of_range",
                        "segment number " + std::to_string(entry.first) +
                            " is beyond the number of supplied segments",
                        entry.second.front(), logical.id);
                    add_local_repair(
                        "segment_number_out_of_range",
                        std::to_string(entry.first),
                        "Remove or renumber the segment at stream index " +
                            std::to_string(entry.second.front()) + ".",
                        "A segment number beyond the supplied sequence implies a "
                        "gap or a duplicate numbering scheme.");
                }
            }

            // Physical order does not have to match segment order, but it is
            // useful to tell a producer that the records are out of order.
            std::vector<std::size_t> physical_order = members;
            std::sort(physical_order.begin(), physical_order.end());
            std::vector<std::size_t> numeric_order;
            numeric_order.reserve(ordered.size());
            for (const OrderedSegment& segment : ordered) {
                numeric_order.push_back(segment.index);
            }
            if (physical_order != numeric_order) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::warning,
                    "segments_out_of_order",
                    "segments are not stored in WARC-Segment-Number order",
                    logical.head_index, logical.id);
            }
        }

        std::vector<std::pair<std::size_t, std::uint64_t>> total_lengths;
        for (const SegmentRef& segment : logical.segments) {
            const Record& record = recs[segment.record_index];
            if (!record.has_header("WARC-Segment-Total-Length")) {
                continue;
            }
            auto total = record.segment_total_length();
            if (!total) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "invalid_segment_total_length",
                    "WARC-Segment-Total-Length is not a non-negative integer",
                    segment.record_index, logical.id);
                add_local_repair(
                    "invalid_segment_total_length", {},
                    "Repair WARC-Segment-Total-Length on the segment at stream "
                    "index " +
                        std::to_string(segment.record_index) + ".",
                    "The declared total length cannot be checked.");
            } else {
                total_lengths.emplace_back(segment.record_index, *total);
            }
        }
        if (options.verify_segment_lengths) {
            if (segmented) {
                if (total_lengths.empty()) {
                    add_logical_issue(
                        logical.diagnostics, group_complete, Severity::error,
                        "segment_total_length_missing",
                        "segmented record has no WARC-Segment-Total-Length",
                        logical.head_index, logical.id);
                    add_local_repair(
                        "segment_total_length_missing", {},
                        "Add WARC-Segment-Total-Length: " +
                            std::to_string(logical.total_length) +
                            " to the final segment of record " + logical.id + ".",
                        "The total length is required to prove that all segments "
                        "were assembled.");
                } else {
                    std::uint64_t declared = total_lengths.front().second;
                    bool conflicting = false;
                    for (const auto& entry : total_lengths) {
                        if (entry.second != declared) {
                            conflicting = true;
                        }
                    }
                    if (conflicting) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::error,
                            "segment_total_length_conflict",
                            "segments disagree about WARC-Segment-Total-Length",
                            logical.head_index, logical.id);
                        add_local_repair(
                            "segment_total_length_conflict", {},
                            "Keep a single WARC-Segment-Total-Length value on the "
                            "final segment and remove conflicting copies.",
                            "Conflicting totals make completeness unverifiable.");
                    } else if (declared != logical.total_length) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::error,
                            "segment_total_length_mismatch",
                            "WARC-Segment-Total-Length is " +
                                std::to_string(declared) +
                                " but the supplied segment blocks total " +
                                std::to_string(logical.total_length),
                            logical.head_index, logical.id);
                        add_local_repair(
                            "segment_total_length_mismatch", {},
                            "Re-export record " + logical.id + " with a complete "
                            "segment set and WARC-Segment-Total-Length: " +
                                std::to_string(logical.total_length) + ".",
                            "The segment bytes do not add up to the declared total.");
                    }
                    std::size_t final_index =
                        logical.segments.empty()
                            ? logical.head_index
                            : logical.segments.back().record_index;
                    bool on_final = false;
                    for (const auto& entry : total_lengths) {
                        if (entry.first == final_index) {
                            on_final = true;
                        }
                    }
                    if (!on_final) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::warning,
                            "segment_total_length_not_final",
                            "WARC-Segment-Total-Length is not on the final segment",
                            logical.head_index, logical.id);
                    }
                }
            } else if (!total_lengths.empty() &&
                       total_lengths.front().second != logical.total_length) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "segment_total_length_mismatch",
                    "WARC-Segment-Total-Length is " +
                        std::to_string(total_lengths.front().second) +
                        " but the record block has " +
                        std::to_string(logical.total_length) + " bytes",
                    logical.head_index, logical.id);
                add_local_repair(
                    "segment_total_length_mismatch", {},
                    "Correct WARC-Segment-Total-Length to " +
                        std::to_string(logical.total_length) + " for record " +
                        logical.id + ".",
                    "The declared total length disagrees with the block.");
            }
        }

        for (std::size_t index : members) {
            const Record& record = recs[index];
            if (record.truncated) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "truncated_record",
                    "segment body is shorter than Content-Length", index,
                    logical.id);
            }
            if (record.malformed) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "malformed_record", "segment has malformed WARC framing",
                    index, logical.id);
            }
        }

        if (options.verify_digests) {
            bool saw_block_digest = false;
            bool saw_payload_digest = false;
            for (const SegmentRef& segment : logical.segments) {
                const Record& record = recs[segment.record_index];
                for (const std::string& value : record.headers("WARC-Block-Digest")) {
                    saw_block_digest = true;
                    std::vector<std::string_view> candidates;
                    candidates.push_back(record.body);
                    candidates.push_back(logical.block);
                    bool matched = false;
                    std::string last_error;
                    for (std::string_view candidate : candidates) {
                        if (verify_digest(value, candidate, nullptr, &last_error)) {
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::error,
                            "block_digest_mismatch",
                            "WARC-Block-Digest does not match the record block: " +
                                last_error,
                            segment.record_index, logical.id);
                        add_local_repair(
                            "block_digest_mismatch", {},
                            "Re-fetch the block of record " + logical.id +
                                " or recompute WARC-Block-Digest from the stored "
                                "block after verifying its provenance.",
                            "The stored bytes do not match the declared block "
                            "digest.");
                    }
                }
                for (const std::string& value :
                     record.headers("WARC-Payload-Digest")) {
                    saw_payload_digest = true;
                    if (logical.type == "revisit") {
                        // A revisit payload digest describes the referenced
                        // record, not the revisit's (usually empty) body.
                        std::string error;
                        if (parse_digest_values(value, &error).empty()) {
                            add_logical_issue(
                                logical.diagnostics, group_complete,
                                Severity::error, "invalid_digest",
                                "WARC-Payload-Digest is invalid: " + error,
                                segment.record_index, logical.id);
                            add_local_repair(
                                "invalid_digest", {},
                                "Repair WARC-Payload-Digest on the revisit record " +
                                    logical.id + ".",
                                "The digest cannot be used to establish a known "
                                "payload.");
                        }
                        continue;
                    }
                    std::vector<std::string> temporary;
                    std::vector<std::string_view> candidates;
                    candidates.push_back(logical.payload);
                    bool unterminated = false;
                    temporary.push_back(extract_payload(
                        record.type(), record.body, record.content_type(),
                        &unterminated));
                    candidates.push_back(temporary.back());
                    bool matched = false;
                    std::string last_error;
                    for (std::string_view candidate : candidates) {
                        if (verify_digest(value, candidate, nullptr, &last_error)) {
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) {
                        add_logical_issue(
                            logical.diagnostics, group_complete, Severity::error,
                            "payload_digest_mismatch",
                            "WARC-Payload-Digest does not match the payload: " +
                                last_error,
                            segment.record_index, logical.id);
                        add_local_repair(
                            "payload_digest_mismatch", {},
                            "Re-fetch the payload of record " + logical.id +
                                " or recompute WARC-Payload-Digest from the stored "
                                "entity body.",
                            "The stored payload does not match the declared digest.");
                    }
                }
            }
            if (options.require_digest && !saw_block_digest && !saw_payload_digest) {
                add_logical_issue(
                    logical.diagnostics, group_complete, Severity::error,
                    "digest_missing",
                    "logical record has neither WARC-Block-Digest nor "
                    "WARC-Payload-Digest",
                    logical.head_index, logical.id);
                add_local_repair(
                    "digest_missing", {},
                    "Add a WARC-Block-Digest or WARC-Payload-Digest to record " +
                        logical.id + ".",
                    "Digest verification was explicitly required.");
            }
        }

        logical.complete = group_complete;
        assembly.logical_records.push_back(std::move(logical));
        logical_missing.push_back(std::move(pending_missing));
        logical_repairs.push_back(std::move(pending_repairs));
    }

    const std::size_t logical_count = assembly.logical_records.size();

    std::unordered_map<std::string, std::vector<std::size_t>> id_to_logicals;
    for (std::size_t logical_index = 0; logical_index < logical_count;
         ++logical_index) {
        for (const SegmentRef& segment :
             assembly.logical_records[logical_index].segments) {
            std::string id = recs[segment.record_index].id();
            if (id.empty()) {
                continue;
            }
            auto& indexes = id_to_logicals[id];
            if (std::find(indexes.begin(), indexes.end(), logical_index) ==
                indexes.end()) {
                indexes.push_back(logical_index);
            }
        }
    }

    auto add_missing = [&](std::size_t source_logical,
                           std::size_t source_record, std::string kind,
                           std::string reference, std::string reason,
                           std::string code, std::string missing_id,
                           std::string action, std::string detail) {
        if (source_logical >= logical_count) {
            return;
        }
        MissingLink missing;
        missing.kind = kind;
        missing.record_id = recs[source_record].id();
        missing.reference = std::move(reference);
        missing.reason = std::move(reason);
        missing.record_index = source_record;
        for (const MissingLink& existing : logical_missing[source_logical]) {
            if (existing.kind == missing.kind &&
                existing.reference == missing.reference &&
                existing.reason == missing.reason) {
                return;
            }
        }
        logical_missing[source_logical].push_back(missing);
        assembly.missing_links.push_back(missing);
        std::string repair_code = code;
        assembly.logical_records[source_logical].diagnostics.push_back(
            make_diagnostic(Severity::error, std::move(code), missing.reason,
                            missing.record_id, missing.reference, source_record,
                            true));
        assembly.logical_records[source_logical].complete = false;
        RepairAction repair = make_repair(
            std::move(repair_code), missing.record_id, std::move(missing_id),
            std::move(action), std::move(detail));
        logical_repairs[source_logical].push_back(repair);
        assembly.repairs.push_back(std::move(repair));
    };

    auto resolve_ref = [&](std::string_view raw_reference,
                           std::size_t source_logical, std::size_t source_record,
                           const std::string& kind, const std::string& missing_code,
                           const std::string& action)
        -> std::optional<std::size_t> {
        std::string id = normalize_record_id(raw_reference);
        if (id.empty()) {
            return std::nullopt;
        }
        auto it = id_to_logicals.find(id);
        if (it == id_to_logicals.end()) {
            add_missing(source_logical, source_record, kind, id,
                        "referenced record is not present in the archive",
                        missing_code, id, action,
                        "The reference must be repaired by importing the missing "
                        "record; no placeholder record is created.");
            return std::nullopt;
        }
        if (it->second.size() > 1) {
            add_missing(source_logical, source_record, kind, id,
                        "reference is ambiguous because the record id is duplicated",
                        "ambiguous_reference", id,
                        "Resolve the duplicate WARC-Record-ID " + id +
                            " before assembly.",
                        "The assembler will not guess which duplicate was intended.");
            return std::nullopt;
        }
        std::size_t target = it->second.front();
        if (!assembly.logical_records[target].has_head) {
            add_missing(source_logical, source_record, kind, id,
                        "reference resolves only to an orphan continuation",
                        missing_code, id, action,
                        "The first segment is still absent, so the payload is not "
                        "known.");
            return std::nullopt;
        }
        return target;
    };

    std::vector<std::vector<std::size_t>> adjacency(logical_count);
    for (std::size_t logical_index = 0; logical_index < logical_count;
         ++logical_index) {
        const LogicalRecord& logical = assembly.logical_records[logical_index];
        bool had_concurrent = false;
        std::vector<std::string> references;
        for (const SegmentRef& segment : logical.segments) {
            for (const std::string& value :
                 recs[segment.record_index].concurrent_to()) {
                for (const std::string& raw : parse_id_list(value)) {
                    had_concurrent = true;
                    references.push_back(raw);
                }
            }
        }
        std::set<std::size_t> targets;
        for (const std::string& raw : references) {
            std::string id = normalize_record_id(raw);
            std::size_t source_record =
                logical.segments.empty() ? logical.head_index
                                         : logical.segments.front().record_index;
            std::string link_kind = "record";
            if (logical.type == "request") {
                link_kind = "response";
            } else if (logical.type == "response" ||
                       logical.type == "revisit") {
                link_kind = "request";
            }
            auto target = resolve_ref(
                raw, logical_index, source_record, link_kind,
                "missing_concurrent_record",
                "Locate and import the record with id " + id +
                    ", then verify WARC-Concurrent-To in the referencing record.");
            if (!target) {
                continue;
            }
            if (*target == logical_index) {
                assembly.logical_records[logical_index].diagnostics.push_back(
                    make_diagnostic(Severity::warning,
                                    "self_concurrent_reference",
                                    "record lists itself in WARC-Concurrent-To",
                                    logical.id, id, source_record, false));
                continue;
            }
            targets.insert(*target);
        }

        if (logical.type == "metadata" && !had_concurrent && logical.has_head) {
            std::string refers = recs[logical.head_index].refers_to();
            if (!refers.empty()) {
                auto target = resolve_ref(
                    refers, logical_index, logical.head_index, "metadata_target",
                    "missing_metadata_target",
                    "Import the metadata target " + refers +
                        " or correct WARC-Refers-To in the metadata record.");
                if (target && *target != logical_index) {
                    targets.insert(*target);
                }
            }
        }
        for (std::size_t target : targets) {
            adjacency[logical_index].push_back(target);
            adjacency[target].push_back(logical_index);
        }
    }
    for (auto& neighbors : adjacency) {
        std::sort(neighbors.begin(), neighbors.end());
        neighbors.erase(std::unique(neighbors.begin(), neighbors.end()),
                        neighbors.end());
    }

    // Resolve revisit targets.  A revisit never receives a copy of the target
    // payload; it only records which known logical record contains it.
    std::vector<std::optional<std::size_t>> direct_revisit_target(logical_count);
    std::vector<std::optional<std::size_t>> revisit_target(logical_count);

    auto payload_digest_matches = [&](std::size_t logical_index,
                                      const std::vector<DigestValue>& digests) {
        const LogicalRecord& logical = assembly.logical_records[logical_index];
        for (const DigestValue& digest : digests) {
            if (digest_hex(digest.algorithm, logical.payload) == digest.hex) {
                return true;
            }
        }
        return false;
    };

    for (std::size_t logical_index = 0; logical_index < logical_count;
         ++logical_index) {
        LogicalRecord& logical = assembly.logical_records[logical_index];
        if (logical.type != "revisit" || !logical.has_head) {
            continue;
        }
        const Record& record = recs[logical.head_index];
        bool resolved = false;
        std::string refers = record.refers_to();
        if (!refers.empty()) {
            direct_revisit_target[logical_index] = resolve_ref(
                refers, logical_index, logical.head_index, "payload",
                "revisit_target_missing",
                "Import the record with id " + refers +
                    " or correct WARC-Refers-To in the revisit record.");
            resolved = direct_revisit_target[logical_index].has_value();
        } else if (!record.refers_to_target_uri().empty()) {
            std::string uri = record.refers_to_target_uri();
            std::string date = record.refers_to_date();
            std::vector<std::size_t> candidates;
            for (std::size_t candidate = 0; candidate < logical_count;
                 ++candidate) {
                if (candidate == logical_index) {
                    continue;
                }
                const LogicalRecord& other = assembly.logical_records[candidate];
                if (!other.has_head ||
                    (other.type != "response" && other.type != "resource" &&
                     other.type != "revisit")) {
                    continue;
                }
                if (other.target_uri != uri) {
                    continue;
                }
                if (!date.empty() && !same_timestamp(other.date, date)) {
                    continue;
                }
                candidates.push_back(candidate);
            }
            std::vector<DigestValue> revisit_digests;
            std::string digest_error;
            std::string payload_digest = record.header("WARC-Payload-Digest");
            if (!payload_digest.empty()) {
                revisit_digests =
                    parse_digest_values(payload_digest, &digest_error);
            }
            if (candidates.size() > 1 && !revisit_digests.empty()) {
                std::vector<std::size_t> filtered;
                for (std::size_t candidate : candidates) {
                    if (payload_digest_matches(candidate, revisit_digests)) {
                        filtered.push_back(candidate);
                    }
                }
                candidates = std::move(filtered);
            }
            if (candidates.size() == 1) {
                direct_revisit_target[logical_index] = candidates.front();
                resolved = true;
            } else if (candidates.empty()) {
                add_missing(
                    logical_index, logical.head_index, "payload", uri,
                    "no known record has the referenced target URI and date",
                    "revisit_target_missing", uri,
                    "Import or re-capture the original response for " + uri +
                        " and verify the revisit's WARC-Refers-To-Target-URI/Date.",
                    "A revisit may only point at a payload that is actually "
                    "present.");
            } else {
                add_missing(
                    logical_index, logical.head_index, "payload", uri,
                    "multiple records match the revisit target URI and date",
                    "revisit_target_ambiguous", uri,
                    "Disambiguate the revisit by adding WARC-Refers-To with the "
                    "intended record id.",
                    "The assembler will not choose one of several candidate "
                    "payloads.");
            }
        } else {
            std::string payload_digest = record.header("WARC-Payload-Digest");
            if (options.revisits_by_digest && !payload_digest.empty()) {
                std::string digest_error;
                std::vector<DigestValue> digests =
                    parse_digest_values(payload_digest, &digest_error);
                if (digests.empty()) {
                    add_logical_issue(
                        logical.diagnostics, logical.complete, Severity::error,
                        "invalid_digest",
                        "WARC-Payload-Digest is invalid: " + digest_error,
                        logical.head_index, logical.id);
                    assembly.repairs.push_back(make_repair(
                        "invalid_digest", logical.id, {},
                        "Repair WARC-Payload-Digest on revisit record " +
                            logical.id + ".",
                        "The digest cannot identify a known payload."));
                } else {
                    std::vector<std::size_t> candidates;
                    for (std::size_t candidate = 0; candidate < logical_count;
                         ++candidate) {
                        if (candidate == logical_index) {
                            continue;
                        }
                        const LogicalRecord& other =
                            assembly.logical_records[candidate];
                        if (!other.has_head ||
                            (other.type != "response" &&
                             other.type != "resource") ||
                            !other.complete) {
                            continue;
                        }
                        if (payload_digest_matches(candidate, digests)) {
                            candidates.push_back(candidate);
                        }
                    }
                    if (candidates.size() == 1) {
                        direct_revisit_target[logical_index] = candidates.front();
                        resolved = true;
                    } else if (candidates.empty()) {
                        add_missing(
                            logical_index, logical.head_index, "payload",
                            payload_digest,
                            "no known payload matches the revisit payload digest",
                            "revisit_target_missing", payload_digest,
                            "Import the payload whose digest is " + payload_digest +
                                ", or correct WARC-Payload-Digest.",
                            "A digest reference is only accepted when it identifies "
                            "one known payload.");
                    } else {
                        add_missing(
                            logical_index, logical.head_index, "payload",
                            payload_digest,
                            "multiple known payloads match the revisit digest",
                            "revisit_target_ambiguous", payload_digest,
                            "Add WARC-Refers-To to identify the intended payload.",
                            "Ambiguous digest references are not resolved by "
                            "guessing.");
                    }
                }
            } else {
                add_missing(
                    logical_index, logical.head_index, "payload", {},
                    "revisit has no WARC-Refers-To, target URI, or payload digest",
                    "revisit_target_missing", {},
                    "Add WARC-Refers-To or WARC-Refers-To-Target-URI/Date to the "
                    "revisit record.",
                    "A revisit must identify an already-known payload.");
            }
        }
        (void)resolved;
    }

    for (std::size_t logical_index = 0; logical_index < logical_count;
         ++logical_index) {
        LogicalRecord& logical = assembly.logical_records[logical_index];
        if (logical.type != "revisit" || !logical.has_head) {
            continue;
        }
        const std::optional<std::size_t> direct =
            direct_revisit_target[logical_index];
        if (!direct) {
            continue;
        }
        std::size_t current = *direct;
        std::set<std::size_t> seen;
        bool cycle = false;
        std::optional<std::size_t> final_target;
        while (true) {
            if (seen.count(current)) {
                cycle = true;
                break;
            }
            seen.insert(current);
            const LogicalRecord& candidate = assembly.logical_records[current];
            if (candidate.type != "revisit") {
                final_target = current;
                break;
            }
            if (!candidate.has_head || !direct_revisit_target[current]) {
                break;
            }
            current = *direct_revisit_target[current];
        }
        if (cycle) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::error,
                "revisit_cycle", "revisit chain contains a cycle",
                logical.head_index, logical.id);
            assembly.repairs.push_back(make_repair(
                "revisit_cycle", logical.id, {},
                "Correct WARC-Refers-To in the revisit records so the chain ends "
                "at a response/resource payload.",
                "A cyclic reference cannot identify a known payload."));
            continue;
        }
        if (!final_target) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::error,
                "revisit_target_unresolved",
                "revisit chain terminates at a revisit with no known target",
                logical.head_index, logical.id);
            assembly.repairs.push_back(make_repair(
                "revisit_target_unresolved", logical.id, {},
                "Import the missing payload or correct the revisit reference "
                "chain ending at " + logical.id + ".",
                "The revisit ultimately references no known payload."));
            continue;
        }
        const LogicalRecord& target = assembly.logical_records[*final_target];
        if (target.type != "response" && target.type != "resource") {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::error,
                "revisit_target_not_payload",
                "revisit ultimately references a record without a payload",
                logical.head_index, target.id);
            assembly.repairs.push_back(make_repair(
                "revisit_target_not_payload", logical.id, target.id,
                "Point the revisit at a response or resource carrying the "
                "original payload.",
                "Revisit references must resolve to payload-bearing records."));
            continue;
        }
        if (!target.segments.empty() &&
            recs[target.segments.front().record_index].has_header("WARC-Truncated")) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::error,
                "revisit_target_truncated",
                "revisit references a record marked WARC-Truncated",
                logical.head_index, target.id);
            assembly.repairs.push_back(make_repair(
                "revisit_target_truncated", logical.id, target.id,
                "Re-fetch the complete payload for " + target.id +
                    " or keep the revisit unresolved.",
                "A truncated target is not a complete known payload."));
            continue;
        }
        if (!target.has_head || !target.complete) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::error,
                "revisit_target_incomplete",
                "revisit references an incomplete payload record",
                logical.head_index, target.id);
            assembly.repairs.push_back(make_repair(
                "revisit_target_incomplete", logical.id, target.id,
                "Repair the referenced payload record " + target.id +
                    " before assembling this revisit.",
                "An incomplete target cannot serve as a known payload."));
            continue;
        }
        logical.revisit_target = *final_target;

        const Record& record = recs[logical.head_index];
        std::string payload_digest = record.header("WARC-Payload-Digest");
        if (!payload_digest.empty()) {
            std::string digest_error;
            std::vector<DigestValue> digests =
                parse_digest_values(payload_digest, &digest_error);
            if (digests.empty()) {
                add_logical_issue(
                    logical.diagnostics, logical.complete, Severity::error,
                    "invalid_digest",
                    "WARC-Payload-Digest is invalid: " + digest_error,
                    logical.head_index, logical.id);
                assembly.repairs.push_back(make_repair(
                    "invalid_digest", logical.id, {},
                    "Repair WARC-Payload-Digest on revisit record " + logical.id +
                        ".",
                    "The digest cannot be checked against the referenced "
                    "payload."));
            } else {
                bool matched = false;
                for (const DigestValue& digest : digests) {
                    if (digest_hex(digest.algorithm, target.payload) ==
                        digest.hex) {
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    add_logical_issue(
                        logical.diagnostics, logical.complete, Severity::error,
                        "revisit_digest_mismatch",
                        "WARC-Payload-Digest does not match the referenced payload",
                        logical.head_index, target.id);
                    assembly.repairs.push_back(make_repair(
                        "revisit_digest_mismatch", logical.id, target.id,
                        "Re-fetch the referenced payload or correct "
                        "WARC-Payload-Digest on the revisit record.",
                        "The revisit claims a payload digest that the known "
                        "payload does not have."));
                }
            }
        }
        if (!record.refers_to_target_uri().empty() &&
            record.refers_to_target_uri() != target.target_uri) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::warning,
                "revisit_target_metadata_mismatch",
                "WARC-Refers-To-Target-URI differs from the target record's "
                "WARC-Target-URI",
                logical.head_index, target.id);
        }
        if (!record.refers_to_date().empty() &&
            !same_timestamp(record.refers_to_date(), target.date)) {
            add_logical_issue(
                logical.diagnostics, logical.complete, Severity::warning,
                "revisit_target_metadata_mismatch",
                "WARC-Refers-To-Date differs from the target record's WARC-Date",
                logical.head_index, target.id);
        }
    }

    // Connected components of concurrent-to / metadata-refers-to links.
    std::vector<int> component(logical_count, -1);
    std::vector<std::vector<std::size_t>> components;
    for (std::size_t start = 0; start < logical_count; ++start) {
        if (component[start] != -1) {
            continue;
        }
        int id = static_cast<int>(components.size());
        components.push_back({});
        std::vector<std::size_t> queue{start};
        component[start] = id;
        for (std::size_t cursor = 0; cursor < queue.size(); ++cursor) {
            std::size_t current = queue[cursor];
            components.back().push_back(current);
            for (std::size_t neighbor : adjacency[current]) {
                if (component[neighbor] == -1) {
                    component[neighbor] = id;
                    queue.push_back(neighbor);
                }
            }
        }
        std::sort(components.back().begin(), components.back().end());
    }

    auto is_root = [&](std::size_t logical_index) {
        const LogicalRecord& logical = assembly.logical_records[logical_index];
        return logical.has_head &&
               (logical.type == "response" || logical.type == "revisit");
    };

    std::vector<bool> in_exchange(logical_count, false);

    auto add_exchange_missing = [&](Exchange& exchange,
                                    std::size_t source_logical,
                                    std::size_t source_record, std::string kind,
                                    std::string reference, std::string reason,
                                    std::string code, std::string missing_id,
                                    std::string action, std::string detail) {
        MissingLink missing;
        missing.kind = std::move(kind);
        missing.record_id = recs[source_record].id();
        missing.reference = std::move(reference);
        missing.reason = std::move(reason);
        missing.record_index = source_record;
        exchange.missing.push_back(missing);
        assembly.missing_links.push_back(missing);
        assembly.diagnostics.push_back(make_diagnostic(
            Severity::error, std::move(code), missing.reason, missing.record_id,
            missing.reference, source_record, true));
        RepairAction repair = make_repair(
            "missing_request", missing.record_id, std::move(missing_id),
            std::move(action), std::move(detail));
        exchange.repairs.push_back(repair);
        assembly.repairs.push_back(std::move(repair));
        // A missing request makes the exchange incomplete, but it does not
        // invalidate the captured response payload for a later revisit.
        (void)source_logical;
    };

    for (const std::vector<std::size_t>& members : components) {
        std::vector<std::size_t> roots;
        for (std::size_t member : members) {
            if (is_root(member)) {
                roots.push_back(member);
            }
        }
        if (roots.empty()) {
            for (std::size_t member : members) {
                const LogicalRecord& logical =
                    assembly.logical_records[member];
                if (logical.type == "request") {
                    assembly.unpaired_requests.push_back(member);
                    if (logical_missing[member].empty()) {
                        add_missing(
                            member,
                            logical.segments.empty()
                                ? logical.head_index
                                : logical.segments.front().record_index,
                            "response", {},
                            "request has no associated response record",
                            "unpaired_request", {},
                            "Capture or import the response for request " +
                                record_label(logical.head_index) +
                                ", and add WARC-Concurrent-To linking it to the "
                                "request.",
                            "The assembler does not create a response body for an "
                            "unpaired request.");
                    }
                    assembly.diagnostics.push_back(make_diagnostic(
                        Severity::error, "unpaired_request",
                        "request record has no response exchange",
                        logical.id, {}, logical.head_index, true));
                } else if (logical.type == "metadata") {
                    assembly.unpaired_metadata.push_back(member);
                    assembly.diagnostics.push_back(make_diagnostic(
                        Severity::warning, "unpaired_metadata",
                        "metadata record is not linked to a request or response",
                        logical.id, {}, logical.head_index, true));
                    assembly.repairs.push_back(make_repair(
                        "unpaired_metadata", logical.id, {},
                        "Link metadata record " + logical.id +
                            " to its response/request with WARC-Concurrent-To or "
                            "WARC-Refers-To.",
                        "Metadata cannot be attached to an exchange without a "
                        "record-id relation."));
                    if (logical_missing[member].empty()) {
                        MissingLink missing;
                        missing.kind = "metadata_target";
                        missing.record_id = logical.id;
                        missing.reason =
                            "metadata record has no WARC-Concurrent-To or "
                            "WARC-Refers-To relation";
                        missing.record_index = logical.head_index;
                        assembly.missing_links.push_back(missing);
                    }
                }
            }
            continue;
        }

        if (roots.size() > 1) {
            assembly.diagnostics.push_back(make_diagnostic(
                Severity::error, "ambiguous_exchange",
                "one concurrent-to component contains multiple response-like "
                "records",
                {}, {}, std::nullopt, true));
            assembly.repairs.push_back(make_repair(
                "ambiguous_exchange", {}, {},
                "Review WARC-Concurrent-To links in the connected component and "
                "split it into one exchange per captured response/revisit.",
                "The assembler emits one exchange per root and does not merge "
                "distinct captures into a fabricated single exchange."));
        }
        const bool ambiguous_component = roots.size() > 1;

        std::set<std::size_t> root_set(roots.begin(), roots.end());
        for (std::size_t root : roots) {
            Exchange exchange;
            exchange.complete = true;
            const LogicalRecord& root_logical =
                assembly.logical_records[root];
            exchange.id = root_logical.id.empty()
                              ? "#record-" + std::to_string(root_logical.head_index)
                              : root_logical.id;
            if (root_logical.type == "response") {
                exchange.response = root;
            } else {
                exchange.revisit = root;
            }

            std::vector<std::size_t> included;
            std::set<std::size_t> seen;
            std::vector<std::size_t> queue{root};
            seen.insert(root);
            for (std::size_t cursor = 0; cursor < queue.size(); ++cursor) {
                std::size_t current = queue[cursor];
                included.push_back(current);
                for (std::size_t neighbor : adjacency[current]) {
                    if (seen.count(neighbor) != 0) {
                        continue;
                    }
                    if (neighbor != root && root_set.count(neighbor) != 0) {
                        continue;
                    }
                    seen.insert(neighbor);
                    queue.push_back(neighbor);
                }
            }
            std::sort(included.begin(), included.end());

            for (std::size_t member : included) {
                in_exchange[member] = true;
                const LogicalRecord& logical =
                    assembly.logical_records[member];
                if (member != root) {
                    if (logical.type == "request") {
                        exchange.requests.push_back(member);
                    } else if (logical.type == "metadata") {
                        exchange.metadata.push_back(member);
                    } else {
                        exchange.related.push_back(member);
                    }
                }
                for (const MissingLink& missing : logical_missing[member]) {
                    bool duplicate = false;
                    for (const MissingLink& existing : exchange.missing) {
                        if (existing.kind == missing.kind &&
                            existing.reference == missing.reference &&
                            existing.reason == missing.reason) {
                            duplicate = true;
                            break;
                        }
                    }
                    if (!duplicate) {
                        exchange.missing.push_back(missing);
                    }
                }
                for (const RepairAction& repair : logical_repairs[member]) {
                    auto found = std::find_if(
                        exchange.repairs.begin(), exchange.repairs.end(),
                        [&](const RepairAction& existing) {
                            return existing.code == repair.code &&
                                   existing.record_id == repair.record_id &&
                                   existing.missing_id == repair.missing_id &&
                                   existing.action == repair.action;
                        });
                    if (found == exchange.repairs.end()) {
                        exchange.repairs.push_back(repair);
                    }
                }
                if (!logical.complete) {
                    exchange.complete = false;
                }
            }

            if (exchange.revisit) {
                if (!root_logical.revisit_target) {
                    exchange.complete = false;
                } else {
                    const LogicalRecord& target = assembly.logical_records[
                        *root_logical.revisit_target];
                    if (!target.complete) {
                        exchange.complete = false;
                    }
                }
            }

            if (options.require_request && exchange.requests.empty()) {
                std::size_t source_record = root_logical.head_index;
                add_exchange_missing(
                    exchange, root, source_record, "request", {},
                    "no request record is associated with this captured "
                    "response",
                    "missing_request", {},
                    "Capture or import the request for " +
                        (root_logical.target_uri.empty()
                             ? record_label(source_record)
                             : root_logical.target_uri) +
                        ", then link it with WARC-Concurrent-To.",
                    "The exchange is intentionally left incomplete rather than "
                    "fabricating a request.");
            }
            if (exchange.requests.size() > 1) {
                assembly.diagnostics.push_back(make_diagnostic(
                    Severity::warning, "multiple_requests",
                    "exchange has more than one request record",
                    exchange.id, {}, root_logical.head_index, false));
            }

            bool root_complete = exchange.response.has_value();
            if (exchange.revisit) {
                root_complete =
                    assembly.logical_records[*exchange.revisit].revisit_target
                        .has_value();
            }
            exchange.complete = exchange.complete && root_complete;
            if (!exchange.missing.empty()) {
                exchange.complete = false;
            }
            if (options.require_request && exchange.requests.empty()) {
                exchange.complete = false;
            }
            if (ambiguous_component) {
                exchange.complete = false;
            }
            assembly.exchanges.push_back(std::move(exchange));
        }
    }

    for (std::size_t logical_index = 0; logical_index < logical_count;
         ++logical_index) {
        const LogicalRecord& logical = assembly.logical_records[logical_index];
        if (logical.type == "request" && !in_exchange[logical_index] &&
            std::find(assembly.unpaired_requests.begin(),
                      assembly.unpaired_requests.end(),
                      logical_index) == assembly.unpaired_requests.end()) {
            assembly.unpaired_requests.push_back(logical_index);
        }
        if (logical.type == "response" && !in_exchange[logical_index] &&
            std::find(assembly.unpaired_responses.begin(),
                      assembly.unpaired_responses.end(),
                      logical_index) == assembly.unpaired_responses.end()) {
            assembly.unpaired_responses.push_back(logical_index);
            assembly.diagnostics.push_back(make_diagnostic(
                Severity::error, "unpaired_response",
                "response record is not part of an exchange",
                logical.id, {}, logical.head_index, true));
        }
        if (logical.type == "metadata" && !in_exchange[logical_index] &&
            std::find(assembly.unpaired_metadata.begin(),
                      assembly.unpaired_metadata.end(),
                      logical_index) == assembly.unpaired_metadata.end()) {
            assembly.unpaired_metadata.push_back(logical_index);
        }
    }

    for (LogicalRecord& logical : assembly.logical_records) {
        for (Diagnostic& diagnostic : logical.diagnostics) {
            assembly.diagnostics.push_back(diagnostic);
        }
    }

    std::sort(assembly.repairs.begin(), assembly.repairs.end(),
              [](const RepairAction& a, const RepairAction& b) {
                  if (a.code != b.code) {
                      return a.code < b.code;
                  }
                  if (a.record_id != b.record_id) {
                      return a.record_id < b.record_id;
                  }
                  if (a.missing_id != b.missing_id) {
                      return a.missing_id < b.missing_id;
                  }
                  if (a.action != b.action) {
                      return a.action < b.action;
                  }
                  return a.detail < b.detail;
              });
    assembly.repairs.erase(
        std::unique(assembly.repairs.begin(), assembly.repairs.end(),
                    [](const RepairAction& a, const RepairAction& b) {
                        return a.code == b.code &&
                               a.record_id == b.record_id &&
                               a.missing_id == b.missing_id &&
                               a.action == b.action &&
                               a.detail == b.detail;
                    }),
        assembly.repairs.end());

    std::sort(assembly.missing_links.begin(), assembly.missing_links.end(),
              [](const MissingLink& a, const MissingLink& b) {
                  if (a.record_id != b.record_id) {
                      return a.record_id < b.record_id;
                  }
                  if (a.kind != b.kind) {
                      return a.kind < b.kind;
                  }
                  if (a.reference != b.reference) {
                      return a.reference < b.reference;
                  }
                  return a.reason < b.reason;
              });
    assembly.missing_links.erase(
        std::unique(assembly.missing_links.begin(),
                    assembly.missing_links.end(),
                    [](const MissingLink& a, const MissingLink& b) {
                        return a.kind == b.kind &&
                               a.record_id == b.record_id &&
                               a.reference == b.reference &&
                               a.reason == b.reason;
                    }),
        assembly.missing_links.end());

    return assembly;
}

Assembly assemble(std::string_view warc, const ParseOptions& parse_options,
                  const AssembleOptions& options) {
    ParseResult parsed = parse_warc(warc, parse_options);
    return assemble(std::move(parsed), options);
}

Assembly assemble(std::istream& input, const ParseOptions& parse_options,
                  const AssembleOptions& options) {
    ParseResult parsed = parse_warc_stream(input, parse_options);
    return assemble(std::move(parsed), options);
}

Assembly assemble(ParseResult parsed, const AssembleOptions& options) {
    Assembly result = assemble(std::move(parsed.records), options);
    result.parse_diagnostics = std::move(parsed.diagnostics);
    return result;
}

bool Assembly::ok() const {
    for (const Diagnostic& diagnostic : parse_diagnostics) {
        if (diagnostic.severity == Severity::error) {
            return false;
        }
    }
    for (const Diagnostic& diagnostic : diagnostics) {
        if (diagnostic.severity == Severity::error) {
            return false;
        }
    }
    return true;
}

bool Assembly::complete() const {
    if (!ok()) {
        return false;
    }
    if (!unpaired_requests.empty() || !unpaired_responses.empty() ||
        !unpaired_metadata.empty()) {
        return false;
    }
    for (const LogicalRecord& logical : logical_records) {
        if (!logical.has_head || !logical.complete) {
            return false;
        }
    }
    for (const Exchange& exchange : exchanges) {
        if (!exchange.complete) {
            return false;
        }
    }
    return !exchanges.empty();
}

const Record& Assembly::record(std::size_t index) const {
    return records.at(index);
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

namespace {

std::string json_escape(std::string_view value) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(value.size() + 8);
    for (unsigned char c : value) {
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\b':
                out += "\\b";
                break;
            case '\f':
                out += "\\f";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out.push_back(kHex[c >> 4]);
                    out.push_back(kHex[c & 0x0f]);
                } else {
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    return out;
}

std::string json_string(std::string_view value) {
    return "\"" + json_escape(value) + "\"";
}

std::string json_bool(bool value) {
    return value ? "true" : "false";
}

std::string json_optional_index(const std::optional<std::size_t>& value) {
    return value ? std::to_string(*value) : "null";
}

std::string json_diagnostic(const Diagnostic& diagnostic) {
    std::ostringstream out;
    out << '{' << "\"severity\":" << json_string(to_string(diagnostic.severity))
        << ",\"code\":" << json_string(diagnostic.code)
        << ",\"message\":" << json_string(diagnostic.message)
        << ",\"record_id\":" << json_string(diagnostic.record_id)
        << ",\"related_id\":" << json_string(diagnostic.related_id)
        << ",\"record_index\":" << json_optional_index(diagnostic.record_index)
        << ",\"repairable\":" << json_bool(diagnostic.repairable) << '}';
    return out.str();
}

std::string json_repair(const RepairAction& repair) {
    std::ostringstream out;
    out << '{' << "\"code\":" << json_string(repair.code)
        << ",\"record_id\":" << json_string(repair.record_id)
        << ",\"missing_id\":" << json_string(repair.missing_id)
        << ",\"action\":" << json_string(repair.action)
        << ",\"detail\":" << json_string(repair.detail) << '}';
    return out.str();
}

std::string json_missing(const MissingLink& missing) {
    std::ostringstream out;
    out << '{' << "\"kind\":" << json_string(missing.kind)
        << ",\"record_id\":" << json_string(missing.record_id)
        << ",\"reference\":" << json_string(missing.reference)
        << ",\"reason\":" << json_string(missing.reason)
        << ",\"record_index\":" << json_optional_index(missing.record_index)
        << '}';
    return out.str();
}

template <typename Container, typename Function>
std::string json_array(const Container& values, Function function) {
    std::ostringstream out;
    out << '[';
    bool first = true;
    for (const auto& value : values) {
        if (!first) {
            out << ',';
        }
        first = false;
        out << function(value);
    }
    out << ']';
    return out.str();
}

std::string json_record(const Record& record) {
    std::ostringstream out;
    out << '{' << "\"index\":" << record.index
        << ",\"offset\":" << record.offset
        << ",\"version\":" << json_string(record.version)
        << ",\"id\":" << json_string(record.id())
        << ",\"raw_id\":" << json_string(record.raw_id())
        << ",\"type\":" << json_string(record.type())
        << ",\"target_uri\":" << json_string(record.target_uri())
        << ",\"date\":" << json_string(record.date())
        << ",\"content_type\":" << json_string(record.content_type())
        << ",\"body_length\":" << record.body.size()
        << ",\"truncated\":" << json_bool(record.truncated)
        << ",\"malformed\":" << json_bool(record.malformed)
        << ",\"headers\":"
        << json_array(record.fields, [](const Field& field) {
               return std::string("{\"name\":") + json_string(field.name) +
                      ",\"value\":" + json_string(field.value) + "}";
           })
        << '}';
    return out.str();
}

std::string json_logical(const LogicalRecord& logical) {
    std::ostringstream out;
    out << '{' << "\"id\":" << json_string(logical.id)
        << ",\"origin_id\":" << json_string(logical.origin_id)
        << ",\"type\":" << json_string(logical.type)
        << ",\"target_uri\":" << json_string(logical.target_uri)
        << ",\"date\":" << json_string(logical.date)
        << ",\"head_index\":" << logical.head_index
        << ",\"has_head\":" << json_bool(logical.has_head)
        << ",\"segmented\":" << json_bool(logical.segmented)
        << ",\"complete\":" << json_bool(logical.complete)
        << ",\"total_length\":" << logical.total_length
        << ",\"block_length\":" << logical.block.size()
        << ",\"payload_length\":" << logical.payload.size()
        << ",\"revisit_target\":"
        << json_optional_index(logical.revisit_target)
        << ",\"segments\":"
        << json_array(logical.segments, [](const SegmentRef& segment) {
               std::ostringstream item;
               item << "{\"record_index\":" << segment.record_index
                    << ",\"number\":" << segment.number
                    << ",\"content_length\":" << segment.content_length << '}';
               return item.str();
           })
        << ",\"diagnostics\":"
        << json_array(logical.diagnostics, json_diagnostic) << '}';
    return out.str();
}

std::string json_exchange(const Exchange& exchange,
                          const std::vector<LogicalRecord>& logicals) {
    auto id_for = [&](std::size_t index) {
        return index < logicals.size() ? logicals[index].id : std::string();
    };
    auto index_items = [&](const std::vector<std::size_t>& indexes) {
        return json_array(indexes, [&](std::size_t index) {
            std::ostringstream item;
            item << "{\"index\":" << index
                 << ",\"id\":" << json_string(id_for(index)) << '}';
            return item.str();
        });
    };
    std::ostringstream out;
    out << '{' << "\"id\":" << json_string(exchange.id)
        << ",\"complete\":" << json_bool(exchange.complete)
        << ",\"response_index\":" << json_optional_index(exchange.response)
        << ",\"response_id\":"
        << json_string(exchange.response ? id_for(*exchange.response)
                                         : std::string())
        << ",\"revisit_index\":" << json_optional_index(exchange.revisit)
        << ",\"revisit_id\":"
        << json_string(exchange.revisit ? id_for(*exchange.revisit)
                                        : std::string())
        << ",\"requests\":" << index_items(exchange.requests)
        << ",\"metadata\":" << index_items(exchange.metadata)
        << ",\"related\":" << index_items(exchange.related)
        << ",\"missing\":" << json_array(exchange.missing, json_missing)
        << ",\"repairs\":" << json_array(exchange.repairs, json_repair) << '}';
    return out.str();
}

std::string json_index_items(const std::vector<std::size_t>& indexes,
                             const std::vector<LogicalRecord>& logicals) {
    return json_array(indexes, [&](std::size_t index) {
        std::ostringstream item;
        item << "{\"index\":" << index
             << ",\"id\":" << json_string(index < logicals.size()
                                             ? logicals[index].id
                                             : std::string())
             << '}';
        return item.str();
    });
}

}  // namespace

std::string to_json(const ParseResult& result) {
    std::ostringstream out;
    out << '{' << "\"ok\":" << json_bool(result.ok())
        << ",\"records\":"
        << json_array(result.records,
                      [](const Record& record) { return json_record(record); })
        << ",\"diagnostics\":"
        << json_array(result.diagnostics, json_diagnostic) << '}';
    return out.str();
}

std::string to_json(const Assembly& assembly) {
    std::size_t errors = 0;
    std::size_t warnings = 0;
    auto count = [&](const std::vector<Diagnostic>& diagnostics) {
        for (const Diagnostic& diagnostic : diagnostics) {
            if (diagnostic.severity == Severity::error) {
                ++errors;
            } else if (diagnostic.severity == Severity::warning) {
                ++warnings;
            }
        }
    };
    count(assembly.parse_diagnostics);
    count(assembly.diagnostics);

    std::size_t complete_exchanges = 0;
    for (const Exchange& exchange : assembly.exchanges) {
        if (exchange.complete) {
            ++complete_exchanges;
        }
    }

    std::ostringstream out;
    out << '{' << "\"ok\":" << json_bool(assembly.ok())
        << ",\"complete\":" << json_bool(assembly.complete())
        << ",\"summary\":{\"records\":" << assembly.records.size()
        << ",\"logical_records\":" << assembly.logical_records.size()
        << ",\"exchanges\":" << assembly.exchanges.size()
        << ",\"complete_exchanges\":" << complete_exchanges
        << ",\"repairs\":" << assembly.repairs.size()
        << ",\"missing_links\":" << assembly.missing_links.size()
        << ",\"errors\":" << errors << ",\"warnings\":" << warnings << '}'
        << ",\"records\":"
        << json_array(assembly.records,
                      [](const Record& record) { return json_record(record); })
        << ",\"logical_records\":"
        << json_array(assembly.logical_records,
                      [](const LogicalRecord& logical) {
                          return json_logical(logical);
                      })
        << ",\"exchanges\":"
        << json_array(assembly.exchanges, [&](const Exchange& exchange) {
               return json_exchange(exchange, assembly.logical_records);
           })
        << ",\"unpaired_requests\":"
        << json_index_items(assembly.unpaired_requests,
                            assembly.logical_records)
        << ",\"unpaired_metadata\":"
        << json_index_items(assembly.unpaired_metadata,
                            assembly.logical_records)
        << ",\"unpaired_responses\":"
        << json_index_items(assembly.unpaired_responses,
                            assembly.logical_records)
        << ",\"missing_links\":"
        << json_array(assembly.missing_links,
                      [](const MissingLink& missing) {
                          return json_missing(missing);
                      })
        << ",\"repairs\":"
        << json_array(assembly.repairs,
                      [](const RepairAction& repair) {
                          return json_repair(repair);
                      })
        << ",\"parse_diagnostics\":"
        << json_array(assembly.parse_diagnostics, json_diagnostic)
        << ",\"diagnostics\":"
        << json_array(assembly.diagnostics, json_diagnostic) << '}';
    return out.str();
}

}  // namespace dataeng
