# Interlaced Image Reconstructor

`imgrecon::InterlacedReconstructor` rebuilds an image from seven numbered,
Adam7-style interlaced data streams.

## Contract

- Sampling grids `(startX, startY, stepX, stepY)`: `(0,0,8,8)`, `(4,0,8,8)`,
  `(0,4,4,8)`, `(2,0,4,4)`, `(0,2,2,4)`, `(1,0,2,2)`, `(0,1,1,2)`.
- Each stream is a sequence of sub-image rows; every row starts with a filter
  byte `0..4` followed by the filtered row payload.
- Filters: `0` none, `1` add left byte `a`, `2` add above byte `b`,
  `3` add `floor((a+b)/2)`, `4` Paeth pick of `a/b/c` nearest `a+b-c` with
  tie order `a`, `b`, `c`.
- Missing neighbours are zero. `a` looks back by the bytes-per-pixel distance;
  the above row is the previous row of the same stream; all byte arithmetic is
  modulo 256.
- Streams may be interleaved and split across arbitrary chunk boundaries.
  Per-stream state, including a row interrupted mid-stream, is retained between
  `feed()` calls.
- A target row is delivered through the callback only once every pixel it
  contains has arrived; rows are emitted top to bottom.
- An illegal filter number or a stream that is too short/too long tears the
  whole image down: `failed()` becomes true, partial state is discarded, and no
  further rows are emitted.

## Minimal use

```cpp
#include "interlaced_reconstructor.h"

imgrecon::InterlacedReconstructor decoder(
    width, height, bytesPerPixel,
    [](std::size_t row, const std::uint8_t* pixels) {
        // pixels points to width * bytesPerPixel bytes for this complete row.
    });

for (/* each chunk as it arrives */) {
    if (!decoder.feed(streamId, chunk)) {
        // decoder.error() describes the failure; the whole image is invalid.
        break;
    }
}
const bool complete = decoder.finish();  // checks every stream length
```

## Build and test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

The tests use an independent forward-filter fixture
(`tests/forward_filter_fixture.h`) that encodes raw images without reusing the
decoder. They cover odd dimensions, empty streams, arbitrary interleaved
chunking (including one byte at a time), Paeth tie-breaking, and the
wrong-length / illegal-filter rollback paths.
