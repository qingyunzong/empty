#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "score.hpp"

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::cerr << "FAIL: " << what << '\n';
    }
}

// Renders events as "pitch start end" lines for easy comparison.
std::string render(const std::vector<score::Event>& events) {
    std::ostringstream oss;
    for (const auto& e : events)
        oss << e.pitch << ' ' << e.start.str() << ' ' << e.end.str() << '\n';
    return oss.str();
}

void check_expansion(const std::string& source, const std::string& expected) {
    try {
        check(render(score::expand_score(source)) == expected,
              "expansion of: " + source + "\n--- got ---\n" +
                  render(score::expand_score(source)) + "--- want ---\n" + expected);
    } catch (const std::exception& e) {
        check(false, "expansion of: " + source + " threw: " + e.what());
    }
}

void check_parse_error(const std::string& source) {
    try {
        score::expand_score(source);
        check(false, "expected ParseError for: " + source);
    } catch (const score::ParseError&) {
        check(true, "");
    }
}

void test_rational() {
    using score::Rational;
    check(Rational(2, 4) == Rational(1, 2), "2/4 reduces to 1/2");
    check(Rational(6, -8) == Rational(-3, 4), "6/-8 reduces to -3/4");
    check(Rational(1, 2) + Rational(1, 3) == Rational(5, 6), "1/2 + 1/3");
    check(Rational(2, 3) * Rational(3, 4) == Rational(1, 2), "2/3 * 3/4");
    check(Rational(1, 2) / Rational(3, 4) == Rational(2, 3), "1/2 / 3/4");
    check(Rational(3, 2).str() == "3/2", "str 3/2");
    check(Rational(4, 2).str() == "2", "str 4/2 -> 2");
}

void test_notes_and_rests() {
    check_expansion("c4/4 d4/4", "c4 0 1\nd4 1 2\n");
    check_expansion("c4/1", "c4 0 4\n");                    // whole note
    check_expansion("c4/4.", "c4 0 3/2\n");                 // dotted quarter
    check_expansion("c4/8..", "c4 0 7/8\n");                // double-dotted 8th
    check_expansion("c4/4 r/8 d4/8", "c4 0 1\nr 1 3/2\nd4 3/2 2\n");
    check_expansion("F#3/2 bb4/16", "f#3 0 2\nbb4 2 9/4\n"); // accidentals, case
    check_expansion("# comment\nc4/4, d4/4 | e4/4 # tail\n",
                    "c4 0 1\nd4 1 2\ne4 2 3\n");
}

void test_tuplets() {
    // Triplet: three equal 8ths squeezed into 1 beat.
    check_expansion("{ c4/8 d4/8 e4/8 } = 1",
                    "c4 0 1/3\nd4 1/3 2/3\ne4 2/3 1\n");
    // Unequal members: quarter + 8th into 1 beat (scale 2/3).
    check_expansion("{ c4/4 d4/8 } = 1",
                    "c4 0 2/3\nd4 2/3 1\n");
    // Fractional target beats.
    check_expansion("{ c4/8 d4/8 } = 3/4",
                    "c4 0 3/8\nd4 3/8 3/4\n");
    // Tuplet containing rests and dotted notes (sum 5/4, scale 4/5).
    check_expansion("{ c4/8. r/8 } = 1",
                    "c4 0 3/5\nr 3/5 1\n");
    // Nested: inner group already at target, outer scale 1.
    check_expansion("{ c4/4 { d4/8 e4/8 } = 1 } = 2",
                    "c4 0 1\nd4 1 3/2\ne4 3/2 2\n");
    // Nested with real scaling on both levels.
    check_expansion("{ { c4/8 d4/8 } = 1 e4/8 } = 1",
                    "c4 0 1/3\nd4 1/3 2/3\ne4 2/3 1\n");
    // Tuplet followed by plain notes: cursor continues correctly.
    check_expansion("{ c4/8 d4/8 e4/8 } = 1 f4/4",
                    "c4 0 1/3\nd4 1/3 2/3\ne4 2/3 1\nf4 1 2\n");
}

void test_nesting_depth() {
    // 16 levels deep is accepted.
    {
        std::string deep;
        for (int i = 0; i < score::kMaxTupletDepth; ++i) deep += "{ ";
        deep += "c4/4 ";
        for (int i = 0; i < score::kMaxTupletDepth; ++i) deep += "} = 1 ";
        check_expansion(deep, "c4 0 1\n");
    }
    // 17 levels is rejected.
    {
        std::string too_deep;
        for (int i = 0; i < score::kMaxTupletDepth + 1; ++i) too_deep += "{ ";
        too_deep += "c4/4 ";
        for (int i = 0; i < score::kMaxTupletDepth + 1; ++i) too_deep += "} = 1 ";
        check_parse_error(too_deep);
    }
}

void test_errors() {
    check_parse_error("c4/0");        // zero denominator
    check_parse_error("c4");          // missing duration
    check_parse_error("x9/4");        // bad pitch
    check_parse_error("{ c4/4 }");    // missing '= beats'
    check_parse_error("{ c4/4 } = 0");   // non-positive target
    check_parse_error("{ c4/4 } = -1");
    check_parse_error("{ c4/4");      // unclosed brace
    check_parse_error("c4/4 }");      // stray brace
    check_parse_error("{ } = 1");     // empty group
    check_parse_error("c4/4x");       // trailing garbage
    check_parse_error("r");           // rest without duration
}

} // namespace

int main() {
    test_rational();
    test_notes_and_rests();
    test_tuplets();
    test_nesting_depth();
    test_errors();

    std::cout << (checks - failures) << "/" << checks << " checks passed\n";
    if (failures > 0) {
        std::cerr << failures << " check(s) FAILED\n";
        return 1;
    }
    return 0;
}
