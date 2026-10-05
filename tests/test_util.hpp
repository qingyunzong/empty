#pragma once

#include "spatial/spatial.hpp"

#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,      \
                         __LINE__, #cond);                                     \
            std::exit(1);                                                      \
        }                                                                      \
    } while (0)

inline std::vector<std::pair<spatial::ObjectId, spatial::Aabb>>
randomWorld(std::mt19937_64& rng, std::size_t count, std::int64_t lo,
            std::int64_t hi, std::int64_t maxExtent) {
    std::uniform_int_distribution<std::int64_t> pos(lo, hi);
    std::uniform_int_distribution<std::int64_t> ext(0, maxExtent);
    std::vector<std::pair<spatial::ObjectId, spatial::Aabb>> world;
    world.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        spatial::Aabb b;
        for (int a = 0; a < 3; ++a) {
            b.min[a] = pos(rng);
            b.max[a] = b.min[a] + ext(rng);
        }
        world.emplace_back(static_cast<spatial::ObjectId>(i), b);
    }
    return world;
}

// Random ray; with some probability aimed at a random world object so that
// hits actually occur. Direction components are sometimes zero.
inline spatial::Ray randomRay(std::mt19937_64& rng,
                              const std::vector<std::pair<spatial::ObjectId, spatial::Aabb>>& world,
                              std::int64_t lo, std::int64_t hi) {
    std::uniform_int_distribution<std::int64_t> pos(lo, hi);
    std::uniform_int_distribution<std::int64_t> comp(-25, 25);
    std::uniform_real_distribution<double> uni(0.0, 1.0);
    spatial::Ray ray;
    for (int a = 0; a < 3; ++a) ray.origin[a] = pos(rng);
    if (!world.empty() && uni(rng) < 0.6) {
        std::uniform_int_distribution<std::size_t> pick(0, world.size() - 1);
        const spatial::Aabb& target = world[pick(rng)].second;
        for (int a = 0; a < 3; ++a) {
            std::uniform_int_distribution<std::int64_t> inside(target.min[a], target.max[a]);
            ray.dir[a] = inside(rng) - ray.origin[a];
        }
    } else {
        for (int a = 0; a < 3; ++a) ray.dir[a] = comp(rng);
    }
    for (int a = 0; a < 3; ++a)
        if (uni(rng) < 0.15) ray.dir[a] = 0;
    return ray;
}

inline bool contains(const std::vector<spatial::ObjectId>& v, spatial::ObjectId id) {
    for (spatial::ObjectId x : v)
        if (x == id) return true;
    return false;
}
