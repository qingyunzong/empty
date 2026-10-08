#pragma once

#include "score/rational.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace score {

struct Event {
    bool isRest = false;
    std::string pitch;   // 休止符时为空
    Rational start;      // 起始拍点（拍）
    Rational end;        // 结束拍点（拍）
};

struct ParseError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// 连音组最大嵌套深度
inline constexpr int kMaxTupletDepth = 16;

// 解析整段乐谱，返回按时间顺序排列的音符/休止事件。
std::vector<Event> parseScore(const std::string& text);

// 有理数格式化：分母为 1 时输出整数，否则输出 "n/d"。
std::string formatRational(const Rational& r);

} // namespace score
