#pragma once

#include "pagefile/page_file.hpp"

#include <atomic>
#include <cstring>

// Test double for IMapper. Counts map/unmap calls and live mappings, and
// stamps every fresh mapping with a per-generation byte so tests can detect
// reads from the wrong (or a released) generation.
class CountingMapper final : public pagefile::IMapper {
public:
    pagefile::Mapping map(std::size_t size) override {
        if (size == 0) {
            size = 1;
        }
        auto* data = new std::byte[size];
        const unsigned char gen = ++generation_;
        std::memset(data, gen, size);
        ++map_calls_;
        ++live_;
        return {data, size};
    }

    void unmap(pagefile::Mapping mapping) noexcept override {
        delete[] mapping.data;
        ++unmap_calls_;
        --live_;
    }

    int map_calls() const { return map_calls_.load(); }
    int unmap_calls() const { return unmap_calls_.load(); }
    int live() const { return live_.load(); }
    unsigned int generation() const { return generation_.load(); }

private:
    std::atomic<int> map_calls_{0};
    std::atomic<int> unmap_calls_{0};
    std::atomic<int> live_{0};
    std::atomic<unsigned char> generation_{0};
};
