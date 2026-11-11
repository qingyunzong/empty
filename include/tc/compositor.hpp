#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace tc {

// 片元：像素坐标、深度、稳定图元 ID 与预乘 RGBA8。
struct Fragment {
    uint32_t x = 0;
    uint32_t y = 0;
    float depth = 0.0f;
    uint32_t primitiveId = 0;
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    uint8_t a = 0;
};

struct Pixel {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    uint8_t a = 0;
};

enum class Status {
    Ok = 0,
    InvalidArgument,
    Conflict,         // 同像素同图元 ID 出现异内容片元，整帧失败
    ScratchFailure,   // 暂存段写入或读取失败，整帧失败
    NotInFrame,       // 未 beginFrame 即推送/完成
};

const char* toString(Status status);

// 行主序 RGBA8 图像，仅在整帧成功合成后由合成器发布。
struct Image {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> rgba;

    const uint8_t* row(uint32_t y) const noexcept {
        return rgba.data() + (static_cast<size_t>(y) * width) * 4u;
    }
    uint8_t* row(uint32_t y) noexcept {
        return rgba.data() + (static_cast<size_t>(y) * width) * 4u;
    }
};

// 预乘 alpha 的 over 算子：out = src + dst * (1 - src.a)。
// 参考实现与分块合成共用同一函数，保证位级一致。
Pixel premultipliedOver(Pixel src, Pixel dst) noexcept;

// 调用方提供的暂存段：分块内存容量耗尽后，溢出片元顺序写入该段，
// 整帧收尾时按索引顺序读回。实现可 backed by 磁盘/共享内存等。
class IScratchSegment {
public:
    virtual ~IScratchSegment() = default;
    virtual Status append(const Fragment& fragment) = 0;
    virtual Status readAt(std::size_t index, Fragment& out) const = 0;
    virtual std::size_t size() const = 0;
    virtual void reset() = 0;
};

// 每个分块在首次溢出时通过工厂获取独立暂存段。
class IScratchFactory {
public:
    virtual ~IScratchFactory() = default;
    virtual std::unique_ptr<IScratchSegment> create(std::size_t tileIndex) = 0;
};

// 默认暂存工厂：进程内存实现（调用方未提供工厂时使用）。
std::shared_ptr<IScratchFactory> defaultInMemoryScratchFactory();

struct CompositorConfig {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t tileSize = 64;
    // 全部分块允许常驻内存的片元总数；每块容量为 max(1, budget / 块数)，
    // 超出部分写入暂存段。
    std::size_t memoryBudgetFragments = 0;
};

// 分块透明合成器。
// 生命周期：beginFrame -> 若干 pushBatch（批次可任意乱序）-> completeFrame。
// 仅当 completeFrame 成功时发布新图像；失败时保留上一次成功发布的图像。
class FrameCompositor {
public:
    FrameCompositor(CompositorConfig config,
                    std::shared_ptr<IScratchFactory> scratchFactory = nullptr);
    ~FrameCompositor();

    FrameCompositor(const FrameCompositor&) = delete;
    FrameCompositor& operator=(const FrameCompositor&) = delete;
    FrameCompositor(FrameCompositor&&) noexcept;
    FrameCompositor& operator=(FrameCompositor&&) noexcept;

    // 开始新一帧，丢弃任何进行中的帧并复位所有分块与暂存段。
    Status beginFrame();

    // 推送一个任意顺序的片元批次。冲突/暂存失败会使该帧进入失败态，
    // 此后本次帧的后续推送将被忽略并返回同一错误。
    Status pushBatch(const Fragment* fragments, std::size_t count);

    // 收尾：读回暂存、分块排序、从后到前合成，成功后发布图像。
    Status completeFrame();

    bool framePublished() const noexcept;
    const Image& publishedImage() const noexcept;
    Status lastError() const noexcept;
    std::size_t spilledFragmentCount() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace tc
