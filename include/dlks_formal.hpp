#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <deque>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dlks_formal {

using Nanoseconds = std::chrono::nanoseconds;

enum class EventKind {
    success,
    error,
};

struct BurnRateAlert {
    std::string name;
    int level = 1;
    Nanoseconds short_window{};
    Nanoseconds long_window{};
    double short_threshold = 0.0;
    double long_threshold = 0.0;
};

struct ErrorBudgetConfig {
    Nanoseconds slo_period{};
    double allowed_error_ratio = 0.0;
    std::vector<Nanoseconds> windows;
    std::vector<BurnRateAlert> alerts;
};

struct BudgetSnapshot {
    std::uint64_t requests = 0;
    std::uint64_t errors = 0;
    double allowed_error_events = 0.0;
    double remaining_error_events = 0.0;
    double remaining_budget_ratio = 1.0;
};

struct WindowSnapshot {
    Nanoseconds window{};
    std::uint64_t requests = 0;
    std::uint64_t errors = 0;
    double error_ratio = 0.0;
    double burn_rate = 0.0;

    [[nodiscard]] bool has_requests() const noexcept { return requests != 0; }
};

struct Snapshot {
    Nanoseconds now{};
    std::int64_t slo_period_index = 0;
    Nanoseconds slo_period_start{};
    Nanoseconds slo_period{};
    double allowed_error_ratio = 0.0;
    BudgetSnapshot budget;
    std::vector<WindowSnapshot> windows;
    bool alerting = false;
    int alert_level = 0;
    std::string alert_name;
    std::vector<int> firing_levels;

    [[nodiscard]] const WindowSnapshot* find_window(Nanoseconds size) const noexcept {
        for (const auto& window : windows) {
            if (window.window == size) {
                return &window;
            }
        }
        return nullptr;
    }
};

class SloErrorBudget {
public:
    using Config = ErrorBudgetConfig;

    explicit SloErrorBudget(ErrorBudgetConfig config)
        : config_(std::move(config)) {
        validate_config();
        collect_windows();
        period_index_ = floor_div(now_.count(), config_.slo_period.count());
    }

    SloErrorBudget(Nanoseconds slo_period,
                   double allowed_error_ratio,
                   Nanoseconds short_window,
                   Nanoseconds long_window,
                   double short_threshold,
                   double long_threshold,
                   std::vector<Nanoseconds> additional_windows = {}) {
        config_.slo_period = slo_period;
        config_.allowed_error_ratio = allowed_error_ratio;
        config_.windows = std::move(additional_windows);
        config_.alerts.push_back(BurnRateAlert{
            .name = "default",
            .level = 1,
            .short_window = short_window,
            .long_window = long_window,
            .short_threshold = short_threshold,
            .long_threshold = long_threshold,
        });
        validate_config();
        collect_windows();
        period_index_ = floor_div(now_.count(), config_.slo_period.count());
    }

    void observe(Nanoseconds timestamp, EventKind kind) {
        observe(timestamp, kind == EventKind::error);
    }

    void observe(Nanoseconds timestamp, bool is_error) {
        if (timestamp > now_) {
            advance_to(timestamp);
        }

        const auto event_period =
            floor_div(timestamp.count(), config_.slo_period.count());
        if (event_period == period_index_) {
            ++period_requests_;
            if (is_error) {
                ++period_errors_;
            }
        }

        for (auto& window : windows_) {
            if (now_ - timestamp < window.size) {
                insert_event(window.events, Event{timestamp, is_error});
                ++window.requests;
                if (is_error) {
                    ++window.errors;
                }
            }
        }
    }

    void success(Nanoseconds timestamp) {
        observe(timestamp, false);
    }

    void error(Nanoseconds timestamp) {
        observe(timestamp, true);
    }

    void advance_to(Nanoseconds now) {
        if (now < now_) {
            throw std::invalid_argument("time cannot move backwards");
        }
        now_ = now;

        const auto new_period =
            floor_div(now_.count(), config_.slo_period.count());
        if (new_period != period_index_) {
            period_index_ = new_period;
            period_requests_ = 0;
            period_errors_ = 0;
        }

        for (auto& window : windows_) {
            auto& events = window.events;
            while (!events.empty() && now_ - events.front().at >= window.size) {
                if (events.front().is_error) {
                    --window.errors;
                }
                --window.requests;
                events.pop_front();
            }
        }
    }

    [[nodiscard]] Snapshot snapshot() const {
        Snapshot result;
        result.now = now_;
        result.slo_period_index = period_index_;
        result.slo_period_start =
            Nanoseconds{period_index_ * config_.slo_period.count()};
        result.slo_period = config_.slo_period;
        result.allowed_error_ratio = config_.allowed_error_ratio;

        result.budget.requests = period_requests_;
        result.budget.errors = period_errors_;
        result.budget.allowed_error_events =
            config_.allowed_error_ratio * static_cast<double>(period_requests_);
        result.budget.remaining_error_events =
            result.budget.allowed_error_events -
            static_cast<double>(period_errors_);
        result.budget.remaining_budget_ratio =
            period_requests_ == 0
                ? 1.0
                : result.budget.remaining_error_events /
                      result.budget.allowed_error_events;

        result.windows.reserve(windows_.size());
        for (const auto& window : windows_) {
            WindowSnapshot item;
            item.window = window.size;
            item.requests = window.requests;
            item.errors = window.errors;
            if (window.requests != 0) {
                item.error_ratio =
                    static_cast<double>(window.errors) /
                    static_cast<double>(window.requests);
                item.burn_rate =
                    item.error_ratio / config_.allowed_error_ratio;
            }
            result.windows.push_back(item);
        }

        for (const auto& alert : config_.alerts) {
            const auto* short_stats = result.find_window(alert.short_window);
            const auto* long_stats = result.find_window(alert.long_window);
            if (short_stats == nullptr || long_stats == nullptr ||
                !short_stats->has_requests() || !long_stats->has_requests()) {
                continue;
            }
            if (short_stats->burn_rate > alert.short_threshold &&
                long_stats->burn_rate > alert.long_threshold) {
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

    [[nodiscard]] Snapshot snapshot_at(Nanoseconds now) {
        advance_to(now);
        return snapshot();
    }

    [[nodiscard]] Snapshot evaluate(Nanoseconds now) {
        return snapshot_at(now);
    }

    [[nodiscard]] const ErrorBudgetConfig& config() const noexcept {
        return config_;
    }

    [[nodiscard]] Nanoseconds now() const noexcept { return now_; }

private:
    struct Event {
        Nanoseconds at{};
        bool is_error = false;
    };

    struct WindowState {
        Nanoseconds size{};
        std::deque<Event> events;
        std::uint64_t requests = 0;
        std::uint64_t errors = 0;
    };

    static std::int64_t floor_div(std::int64_t value, std::int64_t divisor) noexcept {
        const auto quotient = value / divisor;
        const auto remainder = value % divisor;
        return remainder < 0 ? quotient - 1 : quotient;
    }

    static void insert_event(std::deque<Event>& events, Event event) {
        const auto position = std::upper_bound(
            events.begin(), events.end(), event.at,
            [](Nanoseconds at, const Event& existing) {
                return at < existing.at;
            });
        events.insert(position, event);
    }

    void validate_config() const {
        if (config_.slo_period <= Nanoseconds::zero()) {
            throw std::invalid_argument("slo_period must be positive");
        }
        if (!(config_.allowed_error_ratio > 0.0) ||
            config_.allowed_error_ratio > 1.0) {
            throw std::invalid_argument(
                "allowed_error_ratio must be in the interval (0, 1]");
        }
        for (const auto window : config_.windows) {
            if (window <= Nanoseconds::zero()) {
                throw std::invalid_argument("window sizes must be positive");
            }
        }
        for (const auto& alert : config_.alerts) {
            if (alert.short_window <= Nanoseconds::zero() ||
                alert.long_window <= Nanoseconds::zero()) {
                throw std::invalid_argument("alert windows must be positive");
            }
            if (alert.short_threshold < 0.0 ||
                alert.long_threshold < 0.0) {
                throw std::invalid_argument("burn-rate thresholds cannot be negative");
            }
            if (alert.level <= 0) {
                throw std::invalid_argument("alert levels must be positive");
            }
        }
    }

    void collect_windows() {
        auto all_windows = config_.windows;
        for (const auto& alert : config_.alerts) {
            all_windows.push_back(alert.short_window);
            all_windows.push_back(alert.long_window);
        }
        std::sort(all_windows.begin(), all_windows.end());
        all_windows.erase(
            std::unique(all_windows.begin(), all_windows.end()),
            all_windows.end());
        windows_.reserve(all_windows.size());
        for (const auto window : all_windows) {
            WindowState state;
            state.size = window;
            windows_.push_back(std::move(state));
        }
    }

    ErrorBudgetConfig config_;
    std::vector<WindowState> windows_;
    Nanoseconds now_{};
    std::int64_t period_index_ = 0;
    std::uint64_t period_requests_ = 0;
    std::uint64_t period_errors_ = 0;
};

using ErrorBudget = SloErrorBudget;
using ErrorBudgetTracker = SloErrorBudget;
using BurnRateTracker = SloErrorBudget;

}  // namespace dlks_formal

namespace dlks {
using dlks_formal::BurnRateAlert;
using dlks_formal::BurnRateTracker;
using dlks_formal::BudgetSnapshot;
using dlks_formal::ErrorBudget;
using dlks_formal::ErrorBudgetConfig;
using dlks_formal::ErrorBudgetTracker;
using dlks_formal::EventKind;
using dlks_formal::Nanoseconds;
using dlks_formal::SloErrorBudget;
using dlks_formal::Snapshot;
using dlks_formal::WindowSnapshot;
}  // namespace dlks
