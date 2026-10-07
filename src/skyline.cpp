#include "skyline/skyline.hpp"

#include <algorithm>
#include <limits>

namespace skyline {

namespace {

bool isEmpty(const Rect& rect) {
  return rect.height <= 0 || rect.x1 >= rect.x2;
}

}  // namespace

void Skyline::eraseContribution(const Rect& rect) {
  auto eraseOne = [](std::map<Coord, std::multiset<Contribution>>& events,
                     Coord at, Contribution value) {
    auto it = events.find(at);
    if (it == events.end()) return;
    auto found = it->second.find(value);
    if (found != it->second.end()) it->second.erase(found);
    if (it->second.empty()) events.erase(it);
  };
  eraseOne(adds_, rect.x1, {rect.height, rect.id});
  eraseOne(rems_, rect.x2, {rect.height, rect.id});
}

void Skyline::add(Id id, Coord x1, Coord x2, Height height) {
  Rect rect{id, x1, x2, height};
  auto existing = rects_.find(id);
  if (existing != rects_.end()) {
    eraseContribution(existing->second);
    existing->second = rect;
  } else {
    rects_.emplace(id, rect);
  }
  if (isEmpty(rect)) {
    rects_.erase(id);
    return;
  }
  adds_[x1].emplace(height, id);
  rems_[x2].emplace(height, id);
}

bool Skyline::remove(Id id) {
  auto it = rects_.find(id);
  if (it == rects_.end()) return false;
  eraseContribution(it->second);
  rects_.erase(it);
  return true;
}

bool Skyline::contains(Id id) const { return rects_.count(id) != 0; }

std::size_t Skyline::size() const { return rects_.size(); }

void Skyline::clear() {
  rects_.clear();
  adds_.clear();
  rems_.clear();
}

std::vector<Segment> Skyline::snapshot() const {
  std::vector<Coord> points;
  points.reserve(adds_.size() + rems_.size());
  for (const auto& [x, unused] : adds_) points.push_back(x);
  for (const auto& [x, unused] : rems_) points.push_back(x);
  std::sort(points.begin(), points.end());
  points.erase(std::unique(points.begin(), points.end()), points.end());

  std::vector<Segment> out;
  std::multiset<Contribution> active;
  for (std::size_t i = 0; i < points.size(); ++i) {
    const Coord x = points[i];
    if (auto it = rems_.find(x); it != rems_.end()) {
      for (const auto& contribution : it->second)
        active.erase(active.find(contribution));
    }
    if (auto it = adds_.find(x); it != adds_.end()) {
      for (const auto& contribution : it->second) active.insert(contribution);
    }
    if (i + 1 == points.size()) break;
    if (active.empty()) continue;

    const Height top = active.rbegin()->first;
    std::vector<Id> sources;
    for (auto it = active.lower_bound({top, std::numeric_limits<Id>::min()});
         it != active.end() && it->first == top; ++it)
      sources.push_back(it->second);

    const Coord next = points[i + 1];
    if (!out.empty() && out.back().x2 == x && out.back().height == top &&
        out.back().sources == sources) {
      out.back().x2 = next;
    } else {
      out.push_back(Segment{x, next, top, std::move(sources)});
    }
  }
  return out;
}

std::vector<HeightSpan> Skyline::skyline() const {
  std::vector<HeightSpan> out;
  for (const auto& segment : snapshot()) {
    if (!out.empty() && out.back().x2 == segment.x1 &&
        out.back().height == segment.height) {
      out.back().x2 = segment.x2;
    } else {
      out.push_back(HeightSpan{segment.x1, segment.x2, segment.height});
    }
  }
  return out;
}

BatchResult Skyline::applyBatch(const std::vector<Rect>& additions,
                                const std::vector<Id>& removals) {
  BatchResult result;
  result.before = snapshot();
  for (Id id : removals) remove(id);
  for (const Rect& rect : additions) add(rect.id, rect.x1, rect.x2, rect.height);
  result.after = snapshot();
  result.changes = diff(result.before, result.after);
  return result;
}

std::vector<Change> Skyline::diff(const std::vector<Segment>& before,
                                  const std::vector<Segment>& after) {
  std::vector<Coord> points;
  points.reserve(2 * (before.size() + after.size()));
  for (const auto& s : before) {
    points.push_back(s.x1);
    points.push_back(s.x2);
  }
  for (const auto& s : after) {
    points.push_back(s.x1);
    points.push_back(s.x2);
  }
  std::sort(points.begin(), points.end());
  points.erase(std::unique(points.begin(), points.end()), points.end());

  const Segment emptySegment{0, 0, 0, {}};
  auto covering = [](const std::vector<Segment>& segments, std::size_t& index,
                     Coord at) -> const Segment& {
    while (index < segments.size() && segments[index].x2 <= at) ++index;
    if (index < segments.size() && segments[index].x1 <= at &&
        at < segments[index].x2)
      return segments[index];
    static const Segment kEmpty{0, 0, 0, {}};
    return kEmpty;
  };

  std::vector<Change> out;
  std::size_t i = 0, j = 0;
  for (std::size_t k = 0; k + 1 < points.size(); ++k) {
    const Coord a = points[k];
    const Coord b = points[k + 1];
    const Segment& oldSeg = covering(before, i, a);
    const Segment& newSeg = covering(after, j, a);
    const Height oldHeight = oldSeg.x2 > oldSeg.x1 ? oldSeg.height : Height{0};
    const Height newHeight = newSeg.x2 > newSeg.x1 ? newSeg.height : Height{0};
    const std::vector<Id>& oldSources =
        oldSeg.x2 > oldSeg.x1 ? oldSeg.sources : emptySegment.sources;
    const std::vector<Id>& newSources =
        newSeg.x2 > newSeg.x1 ? newSeg.sources : emptySegment.sources;
    if (oldHeight == newHeight && oldSources == newSources) continue;
    if (!out.empty() && out.back().x2 == a &&
        out.back().oldHeight == oldHeight &&
        out.back().newHeight == newHeight &&
        out.back().oldSources == oldSources &&
        out.back().newSources == newSources) {
      out.back().x2 = b;
    } else {
      out.push_back(Change{a, b, oldHeight, newHeight, oldSources, newSources});
    }
  }
  return out;
}

}  // namespace skyline
