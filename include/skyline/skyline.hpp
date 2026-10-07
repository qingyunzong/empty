#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <set>
#include <unordered_map>
#include <utility>
#include <vector>

namespace skyline {

using Id = std::int64_t;
using Coord = std::int64_t;
using Height = std::int64_t;

// Axis-aligned rectangle contribution: half-open interval [x1, x2) at `height`.
// A rectangle is empty (contributes nothing) when height <= 0 or x1 >= x2.
struct Rect {
  Id id{};
  Coord x1{};
  Coord x2{};
  Height height{};
};

// One maximal run of constant height over a half-open interval [x1, x2).
// `sources` lists (sorted, unique) every rectangle id that attains `height`
// on this segment; overlapping rectangles at the same height all appear.
struct Segment {
  Coord x1{};
  Coord x2{};
  Height height{};
  std::vector<Id> sources;

  friend bool operator==(const Segment&, const Segment&) = default;
};

// Height-only view of the skyline (adjacent equal heights merged).
struct HeightSpan {
  Coord x1{};
  Coord x2{};
  Height height{};

  friend bool operator==(const HeightSpan&, const HeightSpan&) = default;
};

// One elementary change between two snapshots. Emitted whenever the height
// OR the source set differs, even if the height itself is unchanged.
struct Change {
  Coord x1{};
  Coord x2{};
  Height oldHeight{};
  Height newHeight{};
  std::vector<Id> oldSources;
  std::vector<Id> newSources;

  bool heightChanged() const { return oldHeight != newHeight; }
  bool sourcesChanged() const { return oldSources != newSources; }

  friend bool operator==(const Change&, const Change&) = default;
};

struct BatchResult {
  std::vector<Segment> before;
  std::vector<Segment> after;
  std::vector<Change> changes;
};

class Skyline {
public:
  // Adds a rectangle. Re-adding an existing id replaces its previous
  // contribution. Empty rectangles (height <= 0 or x1 >= x2) contribute
  // nothing and simply remove any previous rectangle with the same id.
  void add(Id id, Coord x1, Coord x2, Height height);

  // Removes only the contribution of the rectangle with this id.
  // Returns true if such a rectangle existed.
  bool remove(Id id);

  bool contains(Id id) const;
  std::size_t size() const;
  void clear();

  // Detailed snapshot: maximal segments with constant (height, sources).
  // Regions with no covering rectangle are omitted.
  std::vector<Segment> snapshot() const;

  // Height-only skyline: adjacent segments of equal height are merged,
  // so each span boundary is a height change point.
  std::vector<HeightSpan> skyline() const;

  // Applies removals first, then additions, as one batch. Returns the
  // snapshot before and after plus the source-level delta between them.
  BatchResult applyBatch(const std::vector<Rect>& additions,
                         const std::vector<Id>& removals);

  // Delta between two snapshots (e.g. a saved old snapshot and a current
  // one). A Change is emitted wherever height or sources differ; adjacent
  // elementary intervals with identical deltas are merged.
  static std::vector<Change> diff(const std::vector<Segment>& before,
                                  const std::vector<Segment>& after);

private:
  using Contribution = std::pair<Height, Id>;

  void eraseContribution(const Rect& rect);

  std::unordered_map<Id, Rect> rects_;
  std::map<Coord, std::multiset<Contribution>> adds_;
  std::map<Coord, std::multiset<Contribution>> rems_;
};

}  // namespace skyline
