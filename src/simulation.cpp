#include <motion/simulation.hpp>

#include <stdexcept>
#include <utility>

namespace motion {

Simulation::Simulation(std::vector<Particle> particles) : particles_(std::move(particles)) {
    for (std::size_t i = 1; i < particles_.size(); ++i) {
        if (particles_[i - 1].position > particles_[i].position)
            throw std::invalid_argument("particles must be sorted by position");
    }
}

std::optional<Event> Simulation::step() {
    const std::size_t n = particles_.size();
    if (n < 2) return std::nullopt;

    // 最近邻碰撞时间：dt = (x_{i+1} - x_i) / (v_i - v_{i+1})，仅当 v_i > v_{i+1}。
    // 零距初态自然给出 dt = 0，因而被最先处理。
    bool found = false;
    Rational best;
    for (std::size_t i = 0; i + 1 < n; ++i) {
        if (particles_[i].velocity <= particles_[i + 1].velocity) continue;
        Rational dt = (particles_[i + 1].position - particles_[i].position) /
                      (particles_[i].velocity - particles_[i + 1].velocity);
        if (!found || dt < best) {
            best = dt;
            found = true;
        }
    }
    if (!found) return std::nullopt;

    time_ += best;
    for (auto& p : particles_) p.position += p.velocity * best;

    // 推进后“同位置且仍在接近”的相邻对即本刻碰撞对；合并为连续接触组。
    Event event{time_, {}};
    std::size_t i = 0;
    while (i + 1 < n) {
        const bool hit = particles_[i].position == particles_[i + 1].position &&
                         particles_[i].velocity > particles_[i + 1].velocity;
        if (!hit) {
            ++i;
            continue;
        }
        const std::size_t first = i;
        while (i + 1 < n && particles_[i].position == particles_[i + 1].position &&
               particles_[i].velocity > particles_[i + 1].velocity)
            ++i;
        event.groups.push_back({first, i});
    }

    // 各连续接触组内整体反转速度顺序。
    for (const auto& g : event.groups) {
        std::size_t lo = g.first, hi = g.last;
        while (lo < hi) {
            std::swap(particles_[lo].velocity, particles_[hi].velocity);
            ++lo;
            --hi;
        }
    }
    return event;
}

std::vector<Event> Simulation::run(std::size_t max_events) {
    std::vector<Event> events;
    while (events.size() < max_events) {
        auto event = step();
        if (!event) break;
        events.push_back(std::move(*event));
    }
    return events;
}

}  // namespace motion
