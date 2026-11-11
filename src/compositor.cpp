#include "tc/compositor.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <unordered_map>

namespace tc {

const char* toString(Status status) {
    switch (status) {
        case Status::Ok: return "Ok";
        case Status::InvalidArgument: return "InvalidArgument";
        case Status::Conflict: return "Conflict";
        case Status::ScratchFailure: return "ScratchFailure";
        case Status::NotInFrame: return "NotInFrame";
    }
    return "Unknown";
}

Pixel premultipliedOver(Pixel src, Pixel dst) noexcept {
    // 预乘 alpha over：out_c = src_c + dst_c * (255 - src_a) / 255
    Pixel out;
    const uint32_t invA = 255u - static_cast<uint32_t>(src.a);
    auto blend = [invA](uint32_t s, uint32_t d) -> uint8_t {
        return static_cast<uint8_t>(s + (d * invA + 127u) / 255u);
    };
    out.r = blend(src.r, dst.r);
    out.g = blend(src.g, dst.g);
    out.b = blend(src.b, dst.b);
    out.a = blend(src.a, dst.a);
    return out;
}

namespace {

class InMemoryScratchSegment final : public IScratchSegment {
public:
    Status append(const Fragment& fragment) override {
        store_.push_back(fragment);
        return Status::Ok;
    }
    Status readAt(std::size_t index, Fragment& out) const override {
        if (index >= store_.size()) {
            return Status::ScratchFailure;
        }
        out = store_[index];
        return Status::Ok;
    }
    std::size_t size() const override { return store_.size(); }
    void reset() override { store_.clear(); }

private:
    std::vector<Fragment> store_;
};

class InMemoryScratchFactory final : public IScratchFactory {
public:
    std::unique_ptr<IScratchSegment> create(std::size_t) override {
        return std::make_unique<InMemoryScratchSegment>();
    }
};

// 内容指纹：FNV-1a 64，覆盖片元全部字段的规范字节表示。
uint64_t contentFingerprint(const Fragment& f) noexcept {
    uint64_t hash = 1469598103934665603ull;
    auto feed = [&hash](const void* data, std::size_t bytes) {
        const auto* p = static_cast<const unsigned char*>(data);
        for (std::size_t i = 0; i < bytes; ++i) {
            hash ^= static_cast<uint64_t>(p[i]);
            hash *= 1099511628211ull;
        }
    };
    feed(&f.x, sizeof(f.x));
    feed(&f.y, sizeof(f.y));
    feed(&f.depth, sizeof(f.depth));
    feed(&f.primitiveId, sizeof(f.primitiveId));
    feed(&f.r, 1);
    feed(&f.g, 1);
    feed(&f.b, 1);
    feed(&f.a, 1);
    return hash;
}

uint64_t dedupKey(uint32_t x, uint32_t y, uint32_t primitiveId) noexcept {
    // 像素坐标各 32 位 + 图元 ID 32 位，打包为唯一 64 位键。
    const uint64_t pixel =
        (static_cast<uint64_t>(x) << 32) | static_cast<uint64_t>(y);
    // 像素与 ID 不会同时占满 96 位；以 (像素 * 黄金素数) 与 ID 混合。
    return pixel * 11400714819323198485ull ^
           (static_cast<uint64_t>(primitiveId) + 0x9e3779b97f4a7c15ull);
}

struct DedupEntry {
    uint64_t fingerprint;
    bool resident;       // true：位于常驻向量；false：已溢出到暂存段
    std::size_t location;
};

struct TileState {
    uint32_t originX = 0;
    uint32_t originY = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    std::size_t capacity = 0;
    std::vector<Fragment> resident;
    std::unique_ptr<IScratchSegment> scratch;
    std::unordered_map<uint64_t, DedupEntry> index;
};

// 合成顺序：深度从后到前（降序），同深度按图元 ID 升序；
// 再按像素分组，保证同像素片元连续且顺序确定。
bool compositeOrder(const Fragment& a, const Fragment& b) {
    if (a.y != b.y) return a.y < b.y;
    if (a.x != b.x) return a.x < b.x;
    if (a.depth != b.depth) return a.depth > b.depth;
    return a.primitiveId < b.primitiveId;
}

}  // namespace

std::shared_ptr<IScratchFactory> defaultInMemoryScratchFactory() {
    static const auto factory = std::make_shared<InMemoryScratchFactory>();
    return factory;
}

struct FrameCompositor::Impl {
    CompositorConfig config;
    std::shared_ptr<IScratchFactory> factory;
    std::vector<TileState> tiles;
    uint32_t tilesX = 0;
    uint32_t tilesY = 0;
    std::size_t tileCapacity = 0;
    std::size_t spilled = 0;

    bool inFrame = false;
    Status frameError = Status::Ok;
    bool published = false;
    Image image;

    explicit Impl(CompositorConfig cfg, std::shared_ptr<IScratchFactory> f)
        : config(cfg), factory(std::move(f)) {
        if (!factory) {
            factory = defaultInMemoryScratchFactory();
        }
        tilesX = (config.width + config.tileSize - 1) / config.tileSize;
        tilesY = (config.height + config.tileSize - 1) / config.tileSize;
        const std::size_t tileCount =
            static_cast<std::size_t>(tilesX) * tilesY;
        tileCapacity = tileCount == 0
                           ? 1
                           : std::max<std::size_t>(
                                 1, config.memoryBudgetFragments / tileCount);
        tiles.resize(tileCount);
        for (uint32_t ty = 0; ty < tilesY; ++ty) {
            for (uint32_t tx = 0; tx < tilesX; ++tx) {
                TileState& tile = tiles[tileIndex(tx, ty)];
                tile.originX = tx * config.tileSize;
                tile.originY = ty * config.tileSize;
                tile.width = std::min(config.tileSize,
                                      config.width - tile.originX);
                tile.height = std::min(config.tileSize,
                                       config.height - tile.originY);
                tile.capacity = tileCapacity;
                tile.resident.reserve(static_cast<std::size_t>(tile.capacity));
            }
        }
    }

    std::size_t tileIndex(uint32_t tx, uint32_t ty) const noexcept {
        return static_cast<std::size_t>(ty) * tilesX + tx;
    }

    Status begin() {
        if (config.width == 0 || config.height == 0 ||
            config.tileSize == 0) {
            frameError = Status::InvalidArgument;
            return frameError;
        }
        for (TileState& tile : tiles) {
            tile.resident.clear();
            tile.index.clear();
            if (tile.scratch) {
                tile.scratch->reset();
            }
        }
        spilled = 0;
        frameError = Status::Ok;
        inFrame = true;
        return Status::Ok;
    }

    Status push(const Fragment* fragments, std::size_t count) {
        if (!inFrame) {
            return Status::NotInFrame;
        }
        if (frameError != Status::Ok) {
            return frameError;
        }
        if (count > 0 && fragments == nullptr) {
            frameError = Status::InvalidArgument;
            return frameError;
        }
        for (std::size_t i = 0; i < count; ++i) {
            const Fragment& f = fragments[i];
            if (f.x >= config.width || f.y >= config.height ||
                std::isnan(f.depth)) {
                frameError = Status::InvalidArgument;
                return frameError;
            }
            const uint32_t tx = f.x / config.tileSize;
            const uint32_t ty = f.y / config.tileSize;
            TileState& tile = tiles[tileIndex(tx, ty)];
            const uint64_t key = dedupKey(f.x, f.y, f.primitiveId);
            const uint64_t fp = contentFingerprint(f);

            auto found = tile.index.find(key);
            if (found != tile.index.end()) {
                // 同像素同图元 ID：内容一致去重，异内容冲突使整帧失败。
                if (found->second.fingerprint != fp) {
                    frameError = Status::Conflict;
                    return frameError;
                }
                continue;
            }

            if (tile.resident.size() < tile.capacity) {
                tile.index.emplace(
                    key, DedupEntry{fp, true, tile.resident.size()});
                tile.resident.push_back(f);
            } else {
                if (!tile.scratch) {
                    tile.scratch = factory->create(tileIndex(tx, ty));
                    if (!tile.scratch) {
                        frameError = Status::ScratchFailure;
                        return frameError;
                    }
                }
                const Status st = tile.scratch->append(f);
                if (st != Status::Ok) {
                    frameError = Status::ScratchFailure;
                    return frameError;
                }
                tile.index.emplace(
                    key, DedupEntry{fp, false, tile.scratch->size() - 1});
                ++spilled;
            }
        }
        return Status::Ok;
    }

    Status complete(Image& output) {
        if (!inFrame) {
            return Status::NotInFrame;
        }
        if (frameError != Status::Ok) {
            inFrame = false;
            return frameError;
        }

        Image canvas;
        canvas.width = config.width;
        canvas.height = config.height;
        canvas.rgba.assign(
            static_cast<std::size_t>(config.width) * config.height * 4u, 0);

        std::vector<Fragment> merged;
        for (TileState& tile : tiles) {
            merged.clear();
            merged.reserve(tile.resident.size() +
                           (tile.scratch ? tile.scratch->size() : 0));
            merged.insert(merged.end(), tile.resident.begin(),
                          tile.resident.end());
            if (tile.scratch) {
                const std::size_t spilledCount = tile.scratch->size();
                for (std::size_t i = 0; i < spilledCount; ++i) {
                    Fragment f;
                    const Status st = tile.scratch->readAt(i, f);
                    if (st != Status::Ok) {
                        inFrame = false;
                        frameError = Status::ScratchFailure;
                        return frameError;
                    }
                    merged.push_back(f);
                }
            }

            std::sort(merged.begin(), merged.end(), compositeOrder);

            // 按像素扫描；每个像素从透明黑开始，按全局合成顺序 over。
            std::size_t i = 0;
            while (i < merged.size()) {
                const uint32_t px = merged[i].x;
                const uint32_t py = merged[i].y;
                Pixel acc{0, 0, 0, 0};
                while (i < merged.size() && merged[i].x == px &&
                       merged[i].y == py) {
                    const Fragment& f = merged[i];
                    acc = premultipliedOver(Pixel{f.r, f.g, f.b, f.a}, acc);
                    ++i;
                }
                uint8_t* dst = canvas.row(py) +
                               static_cast<std::size_t>(px) * 4u;
                dst[0] = acc.r;
                dst[1] = acc.g;
                dst[2] = acc.b;
                dst[3] = acc.a;
            }
        }

        // 所有分块成功后才发布；此前发布的图像在失败时保持不变。
        output = std::move(canvas);
        published = true;
        inFrame = false;
        frameError = Status::Ok;
        return Status::Ok;
    }
};

FrameCompositor::FrameCompositor(
    CompositorConfig config, std::shared_ptr<IScratchFactory> scratchFactory)
    : impl_(std::make_unique<Impl>(std::move(config),
                                   std::move(scratchFactory))) {}

FrameCompositor::~FrameCompositor() = default;
FrameCompositor::FrameCompositor(FrameCompositor&&) noexcept = default;
FrameCompositor& FrameCompositor::operator=(FrameCompositor&&) noexcept =
    default;

Status FrameCompositor::beginFrame() { return impl_->begin(); }

Status FrameCompositor::pushBatch(const Fragment* fragments,
                                  std::size_t count) {
    return impl_->push(fragments, count);
}

Status FrameCompositor::completeFrame() {
    return impl_->complete(impl_->image);
}

bool FrameCompositor::framePublished() const noexcept {
    return impl_->published;
}

const Image& FrameCompositor::publishedImage() const noexcept {
    return impl_->image;
}

Status FrameCompositor::lastError() const noexcept {
    return impl_->frameError;
}

std::size_t FrameCompositor::spilledFragmentCount() const noexcept {
    return impl_->spilled;
}

}  // namespace tc
