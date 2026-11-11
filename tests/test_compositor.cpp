#include "tc/compositor.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <random>
#include <vector>

using namespace tc;

namespace {

int g_failures = 0;

void check(bool condition, const std::string& message) {
    if (!condition) {
        ++g_failures;
        std::cerr << "FAIL: " << message << '\n';
    }
}

bool sameFragment(const Fragment& a, const Fragment& b) {
    return a.x == b.x && a.y == b.y && a.depth == b.depth &&
           a.primitiveId == b.primitiveId && a.r == b.r && a.g == b.g &&
           a.b == b.b && a.a == b.a;
}

bool refOrder(const Fragment& a, const Fragment& b) {
    if (a.y != b.y) return a.y < b.y;
    if (a.x != b.x) return a.x < b.x;
    if (a.depth != b.depth) return a.depth > b.depth;
    return a.primitiveId < b.primitiveId;
}

uint64_t refKey(const Fragment& f) {
    const uint64_t pixel =
        (static_cast<uint64_t>(f.x) << 32) | static_cast<uint64_t>(f.y);
    return pixel * 11400714819323198485ull ^
           (static_cast<uint64_t>(f.primitiveId) + 0x9e3779b97f4a7c15ull);
}

// 全量排序参考：无内存限制地收集全部片元，去重/冲突检测后全局排序合成。
struct ReferenceOutput {
    Status status = Status::Ok;
    Image image;
    std::size_t uniqueCount = 0;
};

ReferenceOutput referenceComposite(uint32_t width, uint32_t height,
                                   std::vector<Fragment> fragments) {
    ReferenceOutput result;
    std::map<uint64_t, Fragment> unique;
    for (const Fragment& f : fragments) {
        const uint64_t key = refKey(f);
        auto it = unique.find(key);
        if (it == unique.end()) {
            unique.emplace(key, f);
        } else if (!sameFragment(it->second, f)) {
            result.status = Status::Conflict;
            return result;
        }
    }
    std::vector<Fragment> sorted;
    sorted.reserve(unique.size());
    for (const auto& [key, f] : unique) sorted.push_back(f);
    std::sort(sorted.begin(), sorted.end(), refOrder);

    result.uniqueCount = sorted.size();
    result.image.width = width;
    result.image.height = height;
    result.image.rgba.assign(
        static_cast<std::size_t>(width) * height * 4u, 0);

    std::size_t i = 0;
    while (i < sorted.size()) {
        const uint32_t px = sorted[i].x;
        const uint32_t py = sorted[i].y;
        Pixel acc{0, 0, 0, 0};
        while (i < sorted.size() && sorted[i].x == px &&
               sorted[i].y == py) {
            const Fragment& f = sorted[i];
            acc = premultipliedOver(Pixel{f.r, f.g, f.b, f.a}, acc);
            ++i;
        }
        uint8_t* dst =
            result.image.row(py) + static_cast<std::size_t>(px) * 4u;
        dst[0] = acc.r;
        dst[1] = acc.g;
        dst[2] = acc.b;
        dst[3] = acc.a;
    }
    return result;
}

bool bitEqual(const Image& a, const Image& b) {
    return a.width == b.width && a.height == b.height &&
           a.rgba.size() == b.rgba.size() &&
           std::memcmp(a.rgba.data(), b.rgba.data(), a.rgba.size()) == 0;
}

// 可配置失败模式的暂存段，用于覆盖写入/读取失败。
struct MockScratchControls {
    bool failAppend = false;
    bool failRead = false;
};

class MockScratchSegment final : public IScratchSegment {
public:
    explicit MockScratchSegment(std::shared_ptr<MockScratchControls> controls)
        : controls_(std::move(controls)) {}

    Status append(const Fragment& fragment) override {
        if (controls_->failAppend) return Status::ScratchFailure;
        store_.push_back(fragment);
        return Status::Ok;
    }
    Status readAt(std::size_t index, Fragment& out) const override {
        if (controls_->failRead || index >= store_.size()) {
            return Status::ScratchFailure;
        }
        out = store_[index];
        return Status::Ok;
    }
    std::size_t size() const override { return store_.size(); }
    void reset() override { store_.clear(); }

private:
    std::shared_ptr<MockScratchControls> controls_;
    std::vector<Fragment> store_;
};

class MockScratchFactory final : public IScratchFactory {
public:
    explicit MockScratchFactory(std::shared_ptr<MockScratchControls> controls)
        : controls_(std::move(controls)) {}
    std::unique_ptr<IScratchSegment> create(std::size_t) override {
        return std::make_unique<MockScratchSegment>(controls_);
    }

private:
    std::shared_ptr<MockScratchControls> controls_;
};

std::vector<Fragment> generateFragments(uint32_t width, uint32_t height,
                                        uint32_t primitiveSpace,
                                        std::size_t count,
                                        bool transparentOnly,
                                        std::uint64_t seed) {
    std::mt19937_64 rng(seed);
    std::map<uint64_t, Fragment> unique;
    while (unique.size() < count) {
        Fragment f;
        f.x = static_cast<uint32_t>(rng() % width);
        f.y = static_cast<uint32_t>(rng() % height);
        f.primitiveId = static_cast<uint32_t>(rng() % primitiveSpace);
        const uint64_t key = refKey(f);
        if (unique.find(key) != unique.end()) continue;

        // 深度在离散集合中取值，制造同深度场景。
        static const float depths[] = {0.0f, 0.5f, 1.0f, 2.0f, 7.5f, 16.0f};
        f.depth = depths[rng() % 6];
        if (transparentOnly) {
            f.r = f.g = f.b = f.a = 0;
        } else {
            f.a = static_cast<uint8_t>(rng() % 256);
            f.r = static_cast<uint8_t>(rng() % (f.a + 1));
            f.g = static_cast<uint8_t>(rng() % (f.a + 1));
            f.b = static_cast<uint8_t>(rng() % (f.a + 1));
        }
        unique.emplace(key, f);
    }
    std::vector<Fragment> fragments;
    for (const auto& [key, f] : unique) fragments.push_back(f);
    return fragments;
}

std::vector<Fragment> withDuplicates(const std::vector<Fragment>& unique,
                                     std::uint64_t seed) {
    std::mt19937_64 rng(seed);
    std::vector<Fragment> out = unique;
    // 随机插入约 20% 的完全重复片元。
    const std::size_t extra = unique.size() / 5;
    for (std::size_t i = 0; i < extra; ++i) {
        out.push_back(unique[rng() % unique.size()]);
    }
    std::shuffle(out.begin(), out.end(), rng);
    return out;
}

void runCompositor(FrameCompositor& compositor,
                   const std::vector<Fragment>& fragments,
                   std::size_t batchSize, std::uint64_t seed) {
    std::vector<Fragment> shuffled = fragments;
    std::mt19937_64 rng(seed);
    std::shuffle(shuffled.begin(), shuffled.end(), rng);
    compositor.beginFrame();
    for (std::size_t off = 0; off < shuffled.size(); off += batchSize) {
        const std::size_t n = std::min(batchSize, shuffled.size() - off);
        compositor.pushBatch(shuffled.data() + off, n);
    }
    compositor.completeFrame();
}

void testExplicitOrdering() {
    // 同像素三片元：深度 2 在最前；同深度 1.0 按图元 ID 升序。
    const std::vector<Fragment> fragments = {
        {0, 0, 1.0f, 5, 200, 100, 50, 128},
        {0, 0, 2.0f, 2, 30, 40, 50, 255},
        {0, 0, 1.0f, 9, 10, 20, 30, 64},
        {1, 0, 3.0f, 1, 0, 0, 0, 0},  // 完全透明
    };
    const ReferenceOutput ref = referenceComposite(2, 1, fragments);

    // 每块仅容 1 片元，强制走暂存段。
    FrameCompositor compositor(CompositorConfig{2, 1, 8, 1});
    compositor.beginFrame();
    const Fragment batch0[] = {fragments[2], fragments[0]};
    const Fragment batch1[] = {fragments[3]};
    const Fragment batch2[] = {fragments[1]};
    check(compositor.pushBatch(batch0, 2) == Status::Ok, "explicit push 0");
    check(compositor.pushBatch(batch1, 1) == Status::Ok, "explicit push 1");
    check(compositor.pushBatch(batch2, 1) == Status::Ok, "explicit push 2");
    check(compositor.completeFrame() == Status::Ok, "explicit complete");
    check(compositor.framePublished(), "explicit published");
    check(bitEqual(ref.image, compositor.publishedImage()),
          "explicit ordering matches reference");
    check(compositor.spilledFragmentCount() >= 3,
          "explicit fragments spilled to scratch");
}

void testRandomBitExactAcrossBudgetsAndBatches() {
    constexpr uint32_t kWidth = 40;
    constexpr uint32_t kHeight = 24;
    const std::size_t budgets[] = {0, 1, 3, 17, 100000};
    const std::size_t batchSizes[] = {1, 7, 500};

    for (std::uint64_t seed = 1; seed <= 4; ++seed) {
        const std::vector<Fragment> unique =
            generateFragments(kWidth, kHeight, 40, 300, false, seed);
        const std::vector<Fragment> input =
            withDuplicates(unique, seed + 100);
        const ReferenceOutput ref =
            referenceComposite(kWidth, kHeight, input);
        check(ref.status == Status::Ok, "random reference has no conflict");

        for (std::size_t budget : budgets) {
            for (std::size_t batchSize : batchSizes) {
                CompositorConfig cfg{kWidth, kHeight, 8, budget};
                FrameCompositor compositor(cfg);
                runCompositor(compositor, input, batchSize,
                              seed * 1000 + budget + batchSize);
                check(compositor.lastError() == Status::Ok,
                      "random run succeeds");
                check(bitEqual(ref.image, compositor.publishedImage()),
                      "bit-exact across budget/batch combinations");
                if (budget < ref.uniqueCount) {
                    check(compositor.spilledFragmentCount() > 0,
                          "small budget forces spill");
                }
            }
        }
    }
}

void testFullyTransparent() {
    constexpr uint32_t kSize = 8;
    const std::vector<Fragment> unique =
        generateFragments(kSize, kSize, 16, 60, true, 42);
    const std::vector<Fragment> input = withDuplicates(unique, 77);

    FrameCompositor compositor(CompositorConfig{kSize, kSize, 4, 2});
    runCompositor(compositor, input, 3, 99);
    check(compositor.lastError() == Status::Ok, "transparent run succeeds");

    bool allZero = true;
    for (uint8_t v : compositor.publishedImage().rgba) {
        if (v != 0) allZero = false;
    }
    check(allZero, "fully transparent frame publishes all-zero image");

    // 透明片元叠在不透明片元上，结果必须与不透明片元单独合成一致。
    Fragment opaque{2, 2, 5.0f, 1, 120, 60, 30, 200};
    std::vector<Fragment> mixed = {opaque};
    for (std::size_t i = 0; i < 10; ++i) {
        mixed.push_back(Fragment{2, 2, static_cast<float>(i),
                                 100 + static_cast<uint32_t>(i),
                                 0, 0, 0, 0});
    }
    const ReferenceOutput ref = referenceComposite(kSize, kSize, mixed);
    FrameCompositor compositor2(CompositorConfig{kSize, kSize, 4, 1});
    runCompositor(compositor2, mixed, 2, 5);
    check(bitEqual(ref.image, compositor2.publishedImage()),
          "transparent fragments do not alter opaque result");
}

void testOverCapacity() {
    constexpr uint32_t kWidth = 16;
    constexpr uint32_t kHeight = 16;
    const std::vector<Fragment> unique =
        generateFragments(kWidth, kHeight, 32, 200, false, 123);
    const std::vector<Fragment> input = withDuplicates(unique, 321);
    const ReferenceOutput ref =
        referenceComposite(kWidth, kHeight, input);

    // 预算 0：所有片元均经暂存段周转。
    FrameCompositor compositor(CompositorConfig{kWidth, kHeight, 4, 0});
    runCompositor(compositor, input, 5, 888);
    check(compositor.lastError() == Status::Ok, "over-capacity succeeds");
    // 预算 0 时每块仍保留 1 个常驻槽位（共 16 块），
    // 故常驻数等于非空块数，介于 1 与 16 之间。
    const std::size_t spilled = compositor.spilledFragmentCount();
    check(spilled >= ref.uniqueCount - 16 &&
              spilled <= ref.uniqueCount - 1,
          "all but one fragment per tile spilled under zero budget");
    check(bitEqual(ref.image, compositor.publishedImage()),
          "over-capacity output bit-exact with reference");

    // 单块预算 0：容量被夹到 1，即全图唯一常驻槽位，其余经暂存周转。
    FrameCompositor singleTile(CompositorConfig{8, 4, 16, 0});
    std::vector<Fragment> five;
    for (uint32_t i = 0; i < 5; ++i) {
        five.push_back(Fragment{i, 0, static_cast<float>(i),
                                i + 10, 1, 2, 3, 4});
    }
    const ReferenceOutput fiveRef = referenceComposite(8, 4, five);
    runCompositor(singleTile, five, 2, 44);
    check(singleTile.spilledFragmentCount() == fiveRef.uniqueCount - 1,
          "single-tile zero budget spills all but one fragment");
    check(bitEqual(fiveRef.image, singleTile.publishedImage()),
          "single-tile spill output bit-exact");
}

void testDeduplicationAndConflict() {
    constexpr uint32_t kSize = 8;
    std::vector<Fragment> input = {
        {3, 3, 1.0f, 7, 10, 20, 30, 40},
        {3, 3, 1.0f, 7, 10, 20, 30, 40},  // 完全重复，须去重
        {0, 0, 0.0f, 1, 5, 5, 5, 5},
    };
    const ReferenceOutput ref = referenceComposite(kSize, kSize, input);
    check(ref.status == Status::Ok && ref.uniqueCount == 2,
          "reference dedups identical fragments");

    FrameCompositor compositor(CompositorConfig{kSize, kSize, 4, 1});
    runCompositor(compositor, input, 2, 11);
    check(compositor.lastError() == Status::Ok, "duplicate frame succeeds");
    check(bitEqual(ref.image, compositor.publishedImage()),
          "dedup output matches reference");

    // 同像素同图元 ID 但内容不同（深度不同）=> 冲突，整帧失败。
    std::vector<Fragment> conflict = input;
    conflict.push_back(Fragment{3, 3, 9.0f, 7, 10, 20, 30, 40});
    FrameCompositor failing(CompositorConfig{kSize, kSize, 4, 1});
    check(failing.beginFrame() == Status::Ok, "conflict frame begins");
    Status pushStatus = Status::Ok;
    for (const Fragment& f : conflict) {
        pushStatus = failing.pushBatch(&f, 1);
    }
    check(pushStatus == Status::Conflict, "conflict detected on push");
    check(failing.completeFrame() == Status::Conflict,
          "conflict frame not completed");
    check(!failing.framePublished(), "conflict frame never published");

    // 颜色不同同样算冲突。
    std::vector<Fragment> conflict2 = {
        {1, 1, 1.0f, 2, 1, 2, 3, 4},
        {1, 1, 1.0f, 2, 1, 2, 3, 5},
    };
    FrameCompositor failing2(CompositorConfig{kSize, kSize, 4, 1});
    failing2.beginFrame();
    check(failing2.pushBatch(conflict2.data(), conflict2.size()) ==
              Status::Conflict,
          "color mismatch is a conflict");
    check(failing2.completeFrame() == Status::Conflict,
          "color conflict fails the frame");
}

void testScratchFailuresAndRecovery() {
    constexpr uint32_t kSize = 8;
    const std::vector<Fragment> unique =
        generateFragments(kSize, kSize, 16, 40, false, 7);
    const std::vector<Fragment> input = withDuplicates(unique, 8);
    const ReferenceOutput ref = referenceComposite(kSize, kSize, input);

    // 写入失败：预算 0 保证首次溢出即触发暂存写入。
    auto appendControls = std::make_shared<MockScratchControls>();
    appendControls->failAppend = true;
    {
        FrameCompositor compositor(
            CompositorConfig{kSize, kSize, 4, 0},
            std::make_shared<MockScratchFactory>(appendControls));
        compositor.beginFrame();
        Status st = Status::Ok;
        for (const Fragment& f : input) {
            st = compositor.pushBatch(&f, 1);
            if (st != Status::Ok) break;
        }
        check(st == Status::ScratchFailure, "scratch append failure surfaced");
        check(compositor.completeFrame() == Status::ScratchFailure,
              "frame fails on scratch append");
        check(!compositor.framePublished(), "append failure not published");
    }

    // 读取失败：写入成功后，收尾读回时报错，整帧失败且不发布。
    auto readControls = std::make_shared<MockScratchControls>();
    {
        FrameCompositor compositor(
            CompositorConfig{kSize, kSize, 4, 0},
            std::make_shared<MockScratchFactory>(readControls));
        compositor.beginFrame();
        check(compositor.pushBatch(input.data(), input.size()) == Status::Ok,
              "fragments accepted before read phase");
        readControls->failRead = true;
        check(compositor.completeFrame() == Status::ScratchFailure,
              "scratch read failure fails the frame");
        check(!compositor.framePublished(), "read failure not published");

        // 恢复：beginFrame 复位后关闭故障，下一帧成功且位级一致。
        readControls->failRead = false;
        runCompositor(compositor, input, 6, 33);
        check(compositor.lastError() == Status::Ok, "recovered frame succeeds");
        check(compositor.framePublished(), "recovered frame published");
        check(bitEqual(ref.image, compositor.publishedImage()),
              "recovered frame bit-exact with reference");
    }
}

void testPublishGatingAndPreviousImage() {
    FrameCompositor compositor(CompositorConfig{4, 4, 4, 2});
    check(!compositor.framePublished(), "no image before first frame");
    check(compositor.publishedImage().rgba.empty(),
          "empty image before first publish");

    std::vector<Fragment> first = {
        {0, 0, 0.0f, 1, 100, 100, 100, 255},
    };
    runCompositor(compositor, first, 1, 1);
    check(compositor.framePublished(), "first frame published");
    const Image snapshot = compositor.publishedImage();

    // 第二帧冲突失败：已发布图像必须保持不变。
    std::vector<Fragment> conflict = {
        {1, 1, 1.0f, 2, 1, 2, 3, 4},
        {1, 1, 2.0f, 2, 1, 2, 3, 4},
    };
    compositor.beginFrame();
    compositor.pushBatch(conflict.data(), conflict.size());
    check(compositor.completeFrame() == Status::Conflict,
          "second frame fails");
    check(bitEqual(snapshot, compositor.publishedImage()),
          "previous image retained after failed frame");

    // 未 beginFrame 即推送/完成被拒绝。
    FrameCompositor idle(CompositorConfig{4, 4, 4, 2});
    const Fragment f{0, 0, 0.0f, 1, 1, 1, 1, 1};
    check(idle.pushBatch(&f, 1) == Status::NotInFrame,
          "push without beginFrame rejected");
    check(idle.completeFrame() == Status::NotInFrame,
          "complete without beginFrame rejected");
}

void testInvalidArguments() {
    FrameCompositor bad(CompositorConfig{0, 4, 4, 2});
    check(bad.beginFrame() == Status::InvalidArgument,
          "zero-width frame rejected");

    FrameCompositor compositor(CompositorConfig{4, 4, 4, 2});
    compositor.beginFrame();
    const Fragment outOfBounds{4, 0, 0.0f, 1, 1, 1, 1, 1};
    check(compositor.pushBatch(&outOfBounds, 1) == Status::InvalidArgument,
          "out-of-bounds pixel rejected");

    FrameCompositor compositor2(CompositorConfig{4, 4, 4, 2});
    compositor2.beginFrame();
    const Fragment nanFragment{0, 0, std::nanf(""), 1, 1, 1, 1, 1};
    check(compositor2.pushBatch(&nanFragment, 1) ==
              Status::InvalidArgument,
          "NaN depth rejected");
    check(!compositor2.framePublished(), "invalid frame not published");
}

}  // namespace

int main() {
    testExplicitOrdering();
    testRandomBitExactAcrossBudgetsAndBatches();
    testFullyTransparent();
    testOverCapacity();
    testDeduplicationAndConflict();
    testScratchFailuresAndRecovery();
    testPublishGatingAndPreviousImage();
    testInvalidArguments();

    if (g_failures != 0) {
        std::cerr << g_failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all compositor tests passed\n";
    return 0;
}
