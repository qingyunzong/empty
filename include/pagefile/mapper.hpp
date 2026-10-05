#pragma once

#include <cstddef>

namespace pagefile {

// A contiguous region of bytes produced by a mapper. The owner of the mapping
// may write through `data`; views expose it read-only.
struct Mapping {
    std::byte* data = nullptr;
    std::size_t size = 0;
};

// Allocation strategy seam. Production code can back this with mmap/VirtualAlloc;
// tests substitute a counting or scripted fake. Implementations must be safe to
// call from any thread; unmap must be noexcept.
class IMapper {
public:
    virtual ~IMapper() = default;

    // Returns a zero-initialized mapping of at least `size` bytes.
    // Throws on failure; the library state is unchanged in that case.
    virtual Mapping map(std::size_t size) = 0;

    // Releases a mapping previously returned by map(). Must not throw.
    virtual void unmap(Mapping mapping) noexcept = 0;
};

// Portable default backend implemented purely with the C++ standard library.
class HeapMapper final : public IMapper {
public:
    Mapping map(std::size_t size) override {
        if (size == 0) {
            size = 1;
        }
        return Mapping{new std::byte[size](), size};
    }

    void unmap(Mapping mapping) noexcept override { delete[] mapping.data; }
};

} // namespace pagefile
