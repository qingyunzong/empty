#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tilelib {

struct TileId {
    std::uint32_t z = 0;
    std::uint32_t x = 0;
    std::uint32_t y = 0;

    bool operator==(const TileId&) const = default;

    std::optional<TileId> parent() const {
        if (z == 0) return std::nullopt;
        return TileId{z - 1, x / 2, y / 2};
    }

    bool is_ancestor_of(const TileId& other) const {
        if (z > other.z) return false;
        const std::uint32_t shift = other.z - z;
        return (other.x >> shift) == x && (other.y >> shift) == y;
    }
};

struct TileIdHash {
    std::size_t operator()(const TileId& t) const noexcept {
        std::size_t h = static_cast<std::size_t>(t.z) * 2654435761u;
        h ^= static_cast<std::size_t>(t.x) * 2246822519u + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= static_cast<std::size_t>(t.y) * 3266489917u + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

enum class Source { Network, Disk, ParentSubstitute };

inline const char* to_string(Source s) {
    switch (s) {
        case Source::Network: return "network";
        case Source::Disk: return "disk";
        case Source::ParentSubstitute: return "parent-substitute";
    }
    return "unknown";
}

struct Tile {
    TileId id;
    std::uint64_t generation = 0;
    Source source = Source::Network;
    std::vector<std::byte> bytes;
};

enum class EvidenceKind { Admit, Evict, Cancel, LateAdmit, Reject };

inline const char* to_string(EvidenceKind k) {
    switch (k) {
        case EvidenceKind::Admit: return "admit";
        case EvidenceKind::Evict: return "evict";
        case EvidenceKind::Cancel: return "cancel";
        case EvidenceKind::LateAdmit: return "late-admit";
        case EvidenceKind::Reject: return "reject";
    }
    return "unknown";
}

struct Evidence {
    EvidenceKind kind;
    TileId id;
    std::uint64_t generation = 0;
    std::size_t bytes = 0;
    std::string note;
};

} // namespace tilelib
