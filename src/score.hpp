#pragma once

#include <string>
#include <vector>

#include "rational.hpp"

namespace score {

// Maximum tuplet nesting depth accepted by the parser.
inline constexpr int kMaxTupletDepth = 16;

// One parsed item of a score. Groups keep their children so the
// written (unscaled) durations stay available for scaling.
struct Item {
    enum class Kind { Note, Rest, Group };

    Kind kind = Kind::Note;
    std::string pitch;        // empty for rests and groups
    Rational duration;        // written duration in beats (whole note = 4)
    Rational group_target;    // groups only: beats the group is squeezed into
    std::vector<Item> children;
};

// A flattened, absolutely timed event.
struct Event {
    bool is_rest = false;
    std::string pitch;  // "r" for rests
    Rational start;     // beat position from score start
    Rational end;
};

// Thrown on any lexical / syntactic / semantic problem.
struct ParseError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// Parses the score text into a flat list of items (top-level sequence).
std::vector<Item> parse_score(const std::string& text);

// Expands items into absolutely timed events, applying tuplet scaling.
std::vector<Event> expand(const std::vector<Item>& items);

// Convenience: parse + expand.
std::vector<Event> expand_score(const std::string& text);

} // namespace score
