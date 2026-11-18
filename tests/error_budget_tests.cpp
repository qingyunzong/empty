#include "dlks_formal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using dlks_formal::ErrorBudgetConfig;
using dlks_formal::Nanoseconds;
using dlks_formal::SloErrorBudget;
using dlks_formal::Snapshot;

Nanoseconds ns(std::int64_t value) {
    return Nanoseconds{value};
}

void require(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void require_near(double actual, double expected, const std::string& message) {
    const double scale = std::max({1.0, std::abs(actual), std::abs(expected)});
    if (std::abs(actual - expected) > 1e-12 * scale) {
        throw std::runtime_error(
            message + ": expected " + std::to_string(expected) +
            ", got " + std::to_string(actual));
    }
}

enum class TestAction {
    none,
    success,
    error,
};

struct ReferenceEvent {
    Nanoseconds at;
    bool is_error;
};

struct Reference {
    explicit Reference(ErrorBudgetConfig config) : config(std::move(config)) {}

    void observe(Nanoseconds timestamp, bool is_error) {
        if (timestamp > now) {
            now = timestamp;
        }
        events.push_back(ReferenceEvent{timestamp, is_error});
    }

    void advance_to(Nanoseconds timestamp) {
        if (timestamp < now) {
            throw std::runtime_error("reference time moved backwards");
        }
        now = timestamp;
    }

    [[nodiscard]] Snapshot snapshot() const {
        Snapshot result;
        result.now = now;
        result.slo_period = config.slo_period;
        result.allowed_error_ratio = config.allowed_error_ratio;
        const auto period_count = now.count() / config.slo_period.count();
        const auto period_remainder = now.count() % config.slo_period.count();
        result.slo_period_index =
            period_remainder < 0 ? period_count - 1 : period_count;
        const auto period_start =
            result.slo_period_index * config.slo_period.count();
        result.slo_period_start = ns(period_start);
        const auto period_end = period_start + config.slo_period.count();

        for (const auto& event : events) {
            if (event.at.count() >= period_start && event.at.count() < period_end) {
                ++result.budget.requests;
                if (event.is_error) {
                    ++result.budget.errors;
                }
            }
        }
        result.budget.allowed_error_events =
            config.allowed_error_ratio *
            static_cast<double>(result.budget.requests);
        result.budget.remaining_error_events =
            result.budget.allowed_error_events -
            static_cast<double>(result.budget.errors);
        result.budget.remaining_budget_ratio =
            result.budget.requests == 0
                ? 1.0
                : result.budget.remaining_error_events /
                      result.budget.allowed_error_events;

        for (const auto window : config.windows) {
            dlks_formal::WindowSnapshot item;
            item.window = window;
            for (const auto& event : events) {
                if (now - event.at < window) {
                    ++item.requests;
                    if (event.is_error) {
                        ++item.errors;
                    }
                }
            }
            if (item.requests != 0) {
                item.error_ratio =
                    static_cast<double>(item.errors) /
                    static_cast<double>(item.requests);
                item.burn_rate =
                    item.error_ratio / config.allowed_error_ratio;
            }
            result.windows.push_back(item);
        }

        for (const auto& alert : config.alerts) {
            const auto* short_window = result.find_window(alert.short_window);
            const auto* long_window = result.find_window(alert.long_window);
            if (short_window == nullptr || long_window == nullptr ||
                !short_window->has_requests() || !long_window->has_requests()) {
                continue;
            }
            if (short_window->burn_rate > alert.short_threshold &&
                long_window->burn_rate > alert.long_threshold) {
                result.firing_levels.push_back(alert.level);
                if (alert.level > result.alert_level) {
                    result.alert_level = alert.level;
                    result.alert_name = alert.name;
                }
            }
        }
        std::sort(result.firing_levels.begin(), result.firing_levels.end());
        result.firing_levels.erase(
            std::unique(result.firing_levels.begin(), result.firing_levels.end()),
            result.firing_levels.end());
        result.alerting = !result.firing_levels.empty();
        return result;
    }

    ErrorBudgetConfig config;
    std::vector<ReferenceEvent> events;
    Nanoseconds now{};
};

ErrorBudgetConfig test_config() {
    ErrorBudgetConfig config;
    config.slo_period = ns(7);
    config.allowed_error_ratio = 0.2;
    config.windows = {ns(2), ns(4), ns(9)};
    config.alerts = {
        dlks_formal::BurnRateAlert{
            .name = "warning",
            .level = 1,
            .short_window = ns(2),
            .long_window = ns(4),
            .short_threshold = 1.25,
            .long_threshold = 1.0,
        },
        dlks_formal::BurnRateAlert{
            .name = "critical",
            .level = 2,
            .short_window = ns(2),
            .long_window = ns(9),
            .short_threshold = 2.5,
            .long_threshold = 1.5,
        },
    };
    return config;
}

void compare_snapshots(const Snapshot& actual,
                       const Snapshot& expected,
                       const std::string& context) {
    require(actual.now == expected.now, context + ": now");
    require(actual.slo_period_index == expected.slo_period_index,
            context + ": period index");
    require(actual.slo_period_start == expected.slo_period_start,
            context + ": period start");
    require(actual.budget.requests == expected.budget.requests,
            context + ": budget requests");
    require(actual.budget.errors == expected.budget.errors,
            context + ": budget errors");
    require_near(actual.budget.allowed_error_events,
                 expected.budget.allowed_error_events,
                 context + ": allowed error events");
    require_near(actual.budget.remaining_error_events,
                 expected.budget.remaining_error_events,
                 context + ": remaining error events");
    require_near(actual.budget.remaining_budget_ratio,
                 expected.budget.remaining_budget_ratio,
                 context + ": remaining budget ratio");
    require(actual.alerting == expected.alerting, context + ": alerting");
    require(actual.alert_level == expected.alert_level,
            context + ": alert level");
    require(actual.alert_name == expected.alert_name,
            context + ": alert name");
    require(actual.firing_levels == expected.firing_levels,
            context + ": firing levels");
    require(actual.windows.size() == expected.windows.size(),
            context + ": window count");

    for (const auto& wanted : expected.windows) {
        const auto* got = actual.find_window(wanted.window);
        require(got != nullptr, context + ": missing window");
        require(got->requests == wanted.requests, context + ": window requests");
        require(got->errors == wanted.errors, context + ": window errors");
        require_near(got->error_ratio, wanted.error_ratio,
                     context + ": window error ratio");
        require_near(got->burn_rate, wanted.burn_rate,
                     context + ": window burn rate");
    }
}

void compare(const SloErrorBudget& tracker,
             const Reference& reference,
             const std::string& context) {
    compare_snapshots(tracker.snapshot(), reference.snapshot(), context);
}

void exhaustive_event_sequences() {
    constexpr std::array actions{
        TestAction::none,
        TestAction::success,
        TestAction::error,
    };
    constexpr int ticks = 8;
    std::uint64_t total = 1;
    for (int i = 0; i < ticks; ++i) {
        total *= actions.size();
    }

    for (std::uint64_t code = 0; code < total; ++code) {
        auto remaining = code;
        auto config = test_config();
        SloErrorBudget tracker(config);
        Reference reference(std::move(config));

        for (int tick = 0; tick < ticks; ++tick) {
            const auto action = actions[remaining % actions.size()];
            remaining /= actions.size();
            const auto at = ns(tick);
            switch (action) {
            case TestAction::none:
                break;
            case TestAction::success:
                tracker.success(at);
                reference.observe(at, false);
                break;
            case TestAction::error:
                tracker.error(at);
                reference.observe(at, true);
                break;
            }
            tracker.advance_to(at);
            reference.advance_to(at);
            compare(tracker, reference,
                    "exhaustive events code=" + std::to_string(code) +
                        " tick=" + std::to_string(tick));
        }

        for (const auto at : {ns(9), ns(11), ns(16), ns(23)}) {
            tracker.advance_to(at);
            reference.advance_to(at);
            compare(tracker, reference,
                    "exhaustive drain code=" + std::to_string(code));
        }
    }
}

void exhaustive_interleavings() {
    constexpr int steps = 6;
    constexpr std::uint64_t alphabet = 5;
    std::uint64_t total = 1;
    for (int i = 0; i < steps; ++i) {
        total *= alphabet;
    }

    for (std::uint64_t code = 0; code < total; ++code) {
        auto remaining = code;
        auto config = test_config();
        SloErrorBudget tracker(config);
        Reference reference(std::move(config));
        auto now = ns(0);

        for (int step = 0; step < steps; ++step) {
            const auto operation = remaining % alphabet;
            remaining /= alphabet;
            switch (operation) {
            case 0:
                now += ns(1);
                tracker.advance_to(now);
                reference.advance_to(now);
                break;
            case 1:
                tracker.success(now);
                reference.observe(now, false);
                break;
            case 2:
                tracker.error(now);
                reference.observe(now, true);
                break;
            case 3: {
                const auto late = now > ns(0) ? now - ns(1) : now;
                tracker.success(late);
                reference.observe(late, false);
                break;
            }
            case 4: {
                const auto late = now > ns(2) ? now - ns(2) : now;
                tracker.error(late);
                reference.observe(late, true);
                break;
            }
            }
            compare(tracker, reference,
                    "interleaving code=" + std::to_string(code) +
                        " step=" + std::to_string(step));
        }
    }
}

void boundary_and_zero_request_tests() {
    auto config = test_config();
    config.slo_period = ns(100);
    config.allowed_error_ratio = 0.25;
    config.windows = {ns(3), ns(5)};
    config.alerts = {dlks_formal::BurnRateAlert{
        .name = "page",
        .level = 1,
        .short_window = ns(3),
        .long_window = ns(5),
        .short_threshold = 1.6,
        .long_threshold = 1.6,
    }};
    SloErrorBudget tracker(config);

    auto state = tracker.snapshot();
    require(state.windows.size() == 2, "zero: window count");
    require(state.windows[0].burn_rate == 0.0, "zero: short burn rate");
    require(state.windows[1].burn_rate == 0.0, "zero: long burn rate");
    require(!state.alerting, "zero: must not alert");
    require(state.budget.remaining_budget_ratio == 1.0,
            "zero: budget starts full");

    tracker.success(ns(0));
    state = tracker.snapshot_at(ns(3));
    require(state.find_window(ns(3))->requests == 0,
            "boundary: sample expires exactly at the left edge");
    require(!state.alerting, "boundary: no alert after expiry");

    tracker = SloErrorBudget(config);
    tracker.success(ns(0));
    tracker.success(ns(1));
    tracker.success(ns(2));
    tracker.error(ns(3));
    tracker.error(ns(4));
    state = tracker.snapshot_at(ns(4));
    require_near(state.find_window(ns(5))->burn_rate, 1.6,
                 "threshold: burn rate exact equality");
    require(!state.alerting, "threshold: strict greater-than comparison");

    tracker.error(ns(4));
    state = tracker.snapshot_at(ns(4));
    require(state.find_window(ns(3))->burn_rate > 1.6,
            "threshold: short window above threshold");
    require(state.find_window(ns(5))->burn_rate > 1.6,
            "threshold: long window above threshold");
    require(state.alerting && state.alert_level == 1,
            "threshold: alert when both windows fire");
}

void period_and_budget_tests() {
    auto config = test_config();
    config.slo_period = ns(10);
    config.windows = {ns(3), ns(6)};
    config.alerts.clear();
    SloErrorBudget tracker(config);

    tracker.error(ns(9));
    auto state = tracker.snapshot();
    require(state.budget.requests == 1 && state.budget.errors == 1,
            "period: event counted");
    require_near(state.budget.remaining_error_events, -0.8,
                 "period: negative budget is preserved");

    state = tracker.snapshot_at(ns(10));
    require(state.budget.requests == 0 && state.budget.errors == 0,
            "period: budget resets at the boundary");
    require(state.find_window(ns(3))->requests == 1,
            "period: old event remains in a live window");
    require_near(state.budget.remaining_budget_ratio, 1.0,
                 "period: fresh budget");

    tracker.error(ns(9));
    state = tracker.snapshot_at(ns(10));
    require(state.budget.requests == 0,
            "period: late prior-period event does not re-open the budget");
    require(state.find_window(ns(3))->requests == 2,
            "period: late event still lands in the current window");

    tracker.success(ns(10));
    state = tracker.snapshot();
    require(state.budget.requests == 1 && state.budget.errors == 0,
            "period: new period event counted");
    require_near(state.budget.remaining_error_events, 0.2,
                 "period: success earns budget");

    state = tracker.snapshot_at(ns(13));
    require(state.find_window(ns(3))->requests == 0,
            "period: exact boundary expels old window samples");
    require(state.find_window(ns(6))->requests == 3,
            "period: longer window retains samples");
}

void alert_requires_both_windows() {
    auto config = test_config();
    config.slo_period = ns(100);
    config.allowed_error_ratio = 0.25;
    config.windows = {ns(2), ns(10)};
    config.alerts = {dlks_formal::BurnRateAlert{
        .name = "page",
        .level = 1,
        .short_window = ns(2),
        .long_window = ns(10),
        .short_threshold = 1.0,
        .long_threshold = 1.0,
    }};
    SloErrorBudget tracker(config);

    for (int i = 0; i < 6; ++i) {
        tracker.success(ns(i));
    }
    tracker.error(ns(6));
    tracker.error(ns(7));
    auto state = tracker.snapshot();
    require_near(state.find_window(ns(2))->burn_rate, 4.0,
                 "both: short window high");
    require_near(state.find_window(ns(10))->burn_rate, 1.0,
                 "both: long window at threshold");
    require(!state.alerting,
            "both: equal threshold is not enough for the long window");

    tracker.error(ns(7));
    state = tracker.snapshot();
    require_near(state.find_window(ns(10))->burn_rate, 4.0 / 3.0,
                 "both: long window above threshold");
    require(state.alerting, "both: coincident alert");

    tracker = SloErrorBudget(config);
    for (int i = 0; i < 5; ++i) {
        tracker.error(ns(i));
    }
    for (int i = 5; i < 10; ++i) {
        tracker.success(ns(i));
    }
    state = tracker.snapshot();
    require(state.find_window(ns(2))->burn_rate == 0.0,
            "both: short window is quiet");
    require(state.find_window(ns(10))->burn_rate == 2.0,
            "both: long window alone is hot");
    require(!state.alerting, "both: a hot long window alone must not alert");
}

void run(const char* name, void (*test)()) {
    test();
    std::cout << "PASS " << name << '\n';
}

}  // namespace

int main() {
    try {
        run("exhaustive event sequences", exhaustive_event_sequences);
        run("exhaustive interleavings", exhaustive_interleavings);
        run("boundary and zero request", boundary_and_zero_request_tests);
        run("period and budget", period_and_budget_tests);
        run("alert requires both windows", alert_requires_both_windows);
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
