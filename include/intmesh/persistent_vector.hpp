#pragma once

#include <array>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <vector>

namespace intmesh {

// Chunked copy-on-write vector. Copying a PersistentVector is cheap
// (shares reference-counted chunks); writes clone only the touched
// chunk, so previously taken copies never observe later mutations.
// This is the building block that makes Mesh snapshots lifetime-safe
// while keeping incremental updates O(touched elements).
template <typename T, std::size_t ChunkSize = 64>
class PersistentVector {
public:
  using Chunk = std::array<T, ChunkSize>;

  std::size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }

  const T& operator[](std::size_t i) const {
    return (*chunks_[i / ChunkSize])[i % ChunkSize];
  }
  const T& at(std::size_t i) const {
    if (i >= size_) throw std::out_of_range("PersistentVector::at");
    return (*this)[i];
  }

  void pushBack(const T& value) {
    if (size_ % ChunkSize == 0)
      chunks_.push_back(std::make_shared<Chunk>());
    writableChunk(size_ / ChunkSize)[size_ % ChunkSize] = value;
    ++size_;
  }

  void set(std::size_t i, const T& value) {
    if (i >= size_) throw std::out_of_range("PersistentVector::set");
    writableChunk(i / ChunkSize)[i % ChunkSize] = value;
  }

  // Grows to n elements, value-initializing the new ones.
  void resize(std::size_t n) {
    while (size_ < n) pushBack(T{});
    if (n < size_) {
      size_ = n;
      chunks_.resize((n + ChunkSize - 1) / ChunkSize);
    }
  }

private:
  Chunk& writableChunk(std::size_t c) {
    if (!chunks_[c].unique())
      chunks_[c] = std::make_shared<Chunk>(*chunks_[c]);
    return *chunks_[c];
  }

  std::vector<std::shared_ptr<Chunk>> chunks_;
  std::size_t size_ = 0;
};

}  // namespace intmesh
