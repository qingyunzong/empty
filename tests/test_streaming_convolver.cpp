#include "spatial_audio/fft.hpp"
#include "spatial_audio/streaming_convolver.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

using spatial_audio::Complex;
using spatial_audio::FftPlan;
using spatial_audio::StreamingConvolver;

namespace {

int g_failures = 0;

#define CHECK_TRUE(condition, message)                                          \
    do {                                                                        \
        if (!(condition)) {                                                     \
            std::printf("FAIL: %s (%s:%d)\n", (message), __FILE__, __LINE__);  \
            ++g_failures;                                                       \
        }                                                                       \
    } while (0)

#define CHECK_THROWS(expr, message)                                             \
    do {                                                                        \
        bool caught = false;                                                    \
        try {                                                                   \
            expr;                                                               \
        } catch (const std::exception&) {                                      \
            caught = true;                                                      \
        }                                                                      \
        CHECK_TRUE(caught, (message));                                         \
    } while (0)

double pseudo_random(std::mt19937& engine, double amplitude) {
    std::uniform_real_distribution<double> distribution(-amplitude, amplitude);
    return distribution(engine);
}

// Exact piecewise time-domain reference: output sample n is the full linear
// convolution of the input with the response active at sample n.
std::vector<double> reference_switched_convolution(
    const std::vector<double>& input,
    const std::vector<std::vector<double>>& responses,
    const std::vector<std::size_t>& switch_indices) {
    if (input.empty()) {
        return {};
    }
    std::size_t last_response = 0;
    for (std::size_t s = 0; s < switch_indices.size(); ++s) {
        if (switch_indices[s] <= input.size()) {
            last_response = s + 1;
        }
    }
    const std::size_t last_length = responses[last_response].size();
    std::vector<double> output(input.size() + last_length - 1, 0.0);

    for (std::size_t n = 0; n < output.size(); ++n) {
        std::size_t active = 0;
        for (std::size_t s = 0; s < switch_indices.size(); ++s) {
            if (n >= switch_indices[s]) {
                active = s + 1;
            }
        }
        const std::vector<double>& response = responses[active];
        double sum = 0.0;
        for (std::size_t k = 0; k < response.size(); ++k) {
            if (k > n) {
                break;
            }
            const std::ptrdiff_t input_index =
                static_cast<std::ptrdiff_t>(n)
                - static_cast<std::ptrdiff_t>(k);
            if (input_index < static_cast<std::ptrdiff_t>(input.size())) {
                sum += response[k]
                       * input[static_cast<std::size_t>(input_index)];
            }
        }
        output[n] = sum;
    }
    return output;
}

void compare_with_bound(const std::vector<double>& got,
                        const std::vector<double>& expected,
                        double bound, const std::string& label) {
    CHECK_TRUE(got.size() == expected.size(),
               (label + ": output length mismatch").c_str());
    if (got.size() != expected.size()) {
        return;
    }
    double measured = 0.0;
    for (std::size_t i = 0; i < got.size(); ++i) {
        measured = std::max(measured, std::abs(got[i] - expected[i]));
    }
    std::printf("[%s] max absolute error = %.3e (declared bound %.3e)\n",
                label.c_str(), measured, bound);
    CHECK_TRUE(measured <= bound,
               (label + ": absolute error bound violated").c_str());
}

// Drives the streamer through arbitrary push/pull chunking, including
// zero-length pauses and zero-result backpressure pulls.
std::vector<double> run_stream(
    StreamingConvolver& convolver,
    const std::vector<double>& input,
    const std::vector<std::size_t>& push_chunks,
    const std::vector<std::size_t>& pull_chunks,
    std::mt19937& engine) {
    std::size_t pushed = 0;
    std::size_t chunk_index = 0;
    std::vector<double> output;
    while (pushed < input.size()) {
        const std::size_t scheduled =
            push_chunks[chunk_index % push_chunks.size()];
        if (scheduled == 0) {
            convolver.push({}); // explicit pause/no-op
            ++chunk_index;
            continue;
        }
        std::size_t chunk = std::min(scheduled, input.size() - pushed);
        std::vector<double> block;
        block.assign(
            input.begin() + static_cast<std::ptrdiff_t>(pushed),
            input.begin()
                + static_cast<std::ptrdiff_t>(pushed + chunk));
        convolver.push(block); // zero-size block is a legal pause/no-op
        pushed += chunk;
        ++chunk_index;

        std::vector<double> drained;
        const std::size_t request =
            pull_chunks[engine() % pull_chunks.size()];
        const std::size_t received = convolver.pull(drained, request);
        output.insert(output.end(), drained.begin(), drained.end());
        if (request == 0) {
            CHECK_TRUE(received == 0,
                       "zero request must return zero samples");
        }
    }
    convolver.finish();

    const std::size_t target = convolver.expected_total_output();
    while (output.size() < target) {
        std::vector<double> drained;
        // Requests may be zero: verify the backpressure reply, then retry.
        const std::size_t request = engine() % 6;
        const std::size_t received = convolver.pull(drained, request);
        if (received == 0) {
            CHECK_TRUE(request == 0 || convolver.output_available() == 0,
                       "zero pull only when nothing is available");
            continue;
        }
        output.insert(output.end(), drained.begin(), drained.end());
    }
    return output;
}

void test_switch_exact_boundary() {
    std::vector<double> input;
    for (int i = 1; i <= 24; ++i) {
        input.push_back(static_cast<double>(i));
    }
    const std::vector<double> first = {1, 1, 1, 1, 1};
    const std::vector<double> second = {2, -2, 2};
    const std::size_t switch_at = 16; // exact boundary for P=8

    auto reference = reference_switched_convolution(
        input, {first, second}, {switch_at});

    StreamingConvolver convolver(8, 16);
    convolver.set_initial_response(first);
    convolver.switch_response(second, switch_at);
    std::mt19937 engine(55);
    auto output = run_stream(
        convolver, input, {4, 4, 4, 4, 8}, {3, 5, 2}, engine);
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(24.0, 16),
        "switch at exact block boundary");
    CHECK_TRUE(output.size() == input.size() + second.size() - 1,
               "tail length follows the last enabled response");
}

void test_switch_inside_block_uses_history() {
    // Switch points are deliberately off the partition grid, and both new
    // responses need samples strictly older than their activation instant.
    std::vector<double> input(30);
    std::mt19937 engine(888);
    for (double& sample : input) {
        sample = pseudo_random(engine, 1.0);
    }
    const std::vector<double> first =
        {0.4, -0.7, 0.2, 0.9, 0.1, -0.3};
    const std::vector<double> second =
        {1.2, 0.5, -0.8, 0.6, 0.4};
    const std::vector<double> third = {0.9, -0.2, 1.1};
    const std::vector<double> fourth = {-0.6, 0.7, 0.2, -0.4};
    const std::vector<std::size_t> switch_points = {5, 13, 27};

    auto reference = reference_switched_convolution(
        input, {first, second, third, fourth}, switch_points);

    StreamingConvolver convolver(8, 16);
    convolver.set_initial_response(first);
    convolver.switch_response(second, switch_points[0]);
    convolver.switch_response(third, switch_points[1]);
    convolver.switch_response(fourth, switch_points[2]);
    auto output = run_stream(
        convolver, input, {2, 3, 1, 7, 4, 5}, {1, 3, 2, 8}, engine);
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(1.2, 16),
        "three intra-block switches with history");
    CHECK_TRUE(output.size() == input.size() + fourth.size() - 1,
               "final tail uses the last response length");
}

void test_switch_at_stream_end() {
    // Scheduling the switch exactly at N: every real output keeps the first
    // filter, but the tail length belongs to the new response.
    std::vector<double> input(17);
    std::mt19937 engine(31);
    for (double& sample : input) {
        sample = pseudo_random(engine, 1.0);
    }
    const std::vector<double> first = {0.5, 0.5, 0.5, 0.5};
    const std::vector<double> second = {1.0, -1.0, 0.0, 0.5, 0.25};
    const std::size_t switch_at = input.size();

    auto reference = reference_switched_convolution(
        input, {first, second}, {switch_at});

    StreamingConvolver convolver(4, 16);
    convolver.set_initial_response(first);
    convolver.switch_response(second, switch_at);
    auto output = run_stream(
        convolver, input, {4, 4, 4, 5}, {2, 3, 1, 6}, engine);
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(1.0, 16),
        "switch exactly at stream end");
    CHECK_TRUE(output.size() == input.size() + second.size() - 1,
               "end switch changes tail length only");
}

void test_pause_and_backpressure() {
    std::vector<double> input;
    for (std::size_t i = 0; i < 36; ++i) {
        input.push_back(
            0.8 * std::sin(static_cast<double>(i) * 0.31));
    }
    const std::vector<double> response =
        {0.6, -0.4, 0.3, 0.2, -0.1, 0.05};
    auto reference =
        reference_switched_convolution(input, {response}, {});

    StreamingConvolver convolver(8, 16);
    convolver.set_initial_response(response);

    std::vector<double> output;
    std::vector<double> drained;
    convolver.push(
        std::vector<double>(input.begin(), input.begin() + 8));
    // Long consumer pause: no pulls while more blocks arrive, plus empty
    // pushes. The internal FIFO must accumulate without data loss.
    convolver.push({});
    convolver.push(
        std::vector<double>(input.begin() + 8, input.begin() + 20));
    convolver.push({});
    CHECK_TRUE(convolver.pull(drained, 0) == 0,
               "zero request returns nothing");

    convolver.push(
        std::vector<double>(input.begin() + 20, input.end()));
    convolver.finish();

    while (true) {
        const std::size_t received = convolver.pull(drained, 3);
        if (received == 0) {
            break;
        }
        output.insert(output.end(), drained.begin(), drained.end());
    }
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(0.8, 16),
        "pause then drain with backpressure");
}

void test_validation_errors() {
    CHECK_THROWS(StreamingConvolver(0, 8), "zero partition rejected");
    CHECK_THROWS(StreamingConvolver(6, 8),
                 "non-power-of-two partition rejected");
    CHECK_THROWS(StreamingConvolver(8, 0),
                 "zero maximum response rejected");

    StreamingConvolver convolver(8, 8);
    CHECK_THROWS(convolver.set_initial_response({}),
                 "empty response rejected");
    CHECK_THROWS(convolver.set_initial_response(
                     std::vector<double>(9, 1.0)),
                 "oversized response rejected");

    convolver.set_initial_response({1.0, 2.0});
    CHECK_THROWS(convolver.set_initial_response({1.0}),
                 "initial response set twice rejected");
    convolver.push({1.0, 2.0});
    CHECK_THROWS(convolver.switch_response(
                     std::vector<double>(9, 1.0), 10),
                 "oversized replacement rejected");
    CHECK_THROWS(convolver.switch_response({1.0}, 1),
                 "switch in the past rejected");
    convolver.finish();
    CHECK_THROWS(convolver.push({1.0}),
                 "push after finish rejected");
    CHECK_THROWS(convolver.switch_response({1.0}, 5),
                 "switch after finish rejected");
}

void test_max_length_new_filter_uses_full_history() {
    // The replacement filter spans the full configured maximum (K_max
    // partitions) and activates mid-block, so its warm start must reach every
    // retained historical input block.
    constexpr std::size_t P = 8;
    constexpr std::size_t MaxM = 40; // 5 partitions
    std::vector<double> input(45);
    std::mt19937 engine(424242);
    for (double& sample : input) {
        sample = pseudo_random(engine, 1.0);
    }
    std::vector<double> first = {0.3, -0.6, 0.9};
    std::vector<double> long_response(MaxM);
    for (std::size_t i = 0; i < MaxM; ++i) {
        long_response[i] =
            0.5 * std::exp(-static_cast<double>(i) / 7.0)
            * std::cos(0.4 * static_cast<double>(i));
    }
    const std::size_t switch_at = 29; // mid-block for P=8

    auto reference = reference_switched_convolution(
        input, {first, long_response}, {switch_at});

    StreamingConvolver convolver(P, MaxM);
    convolver.set_initial_response(first);
    convolver.switch_response(long_response, switch_at);

    // Pull eagerly between pushes to confirm accounting stays exact even when
    // the FIFO is partially drained before the switch and finish.
    std::vector<double> output;
    std::size_t pushed = 0;
    const std::size_t chunks[] = {6, 6, 6, 6, 6, 6, 6, 3};
    for (std::size_t chunk : chunks) {
        std::vector<double> block(
            input.begin() + static_cast<std::ptrdiff_t>(pushed),
            input.begin()
                + static_cast<std::ptrdiff_t>(pushed + chunk));
        convolver.push(block);
        pushed += chunk;
        std::vector<double> drained;
        convolver.pull(drained, 5);
        output.insert(output.end(), drained.begin(), drained.end());
    }
    convolver.finish();
    CHECK_TRUE(convolver.expected_total_output()
                   == input.size() + long_response.size() - 1,
               "total output length after partial pulls and finish");
    while (output.size() < convolver.expected_total_output()) {
        std::vector<double> drained;
        const std::size_t received = convolver.pull(drained, 4);
        if (received == 0) {
            break;
        }
        output.insert(output.end(), drained.begin(), drained.end());
    }
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(1.0, MaxM),
        "max-length mid-block switch with full history");
}

void test_randomized_fuzz() {
    std::mt19937 engine(0xC0FFEE);
    std::uniform_int_distribution<std::size_t> partition_pick(0, 3);
    const std::size_t partitions[] = {4, 8, 16, 32};
    std::uniform_int_distribution<std::size_t> input_pick(1, 70);
    std::uniform_int_distribution<std::size_t> length_pick(1, 40);

    for (int trial = 0; trial < 40; ++trial) {
        const std::size_t partition =
            partitions[partition_pick(engine)];
        const std::size_t max_response =
            partition * (1 + engine() % 5);
        std::vector<double> input(input_pick(engine));
        for (double& sample : input) {
            sample = pseudo_random(engine, 1.0);
        }

        std::vector<std::vector<double>> responses;
        std::vector<std::size_t> switch_points;
        responses.emplace_back(length_pick(engine) % max_response + 1);
        for (double& coefficient : responses[0]) {
            coefficient = pseudo_random(engine, 1.0);
        }

        StreamingConvolver convolver(partition, max_response);
        convolver.set_initial_response(responses[0]);

        const int switch_count = engine() % 4;
        for (int s = 0; s < switch_count; ++s) {
            std::vector<double> next(
                length_pick(engine) % max_response + 1);
            for (double& coefficient : next) {
                coefficient = pseudo_random(engine, 1.0);
            }
            const std::size_t point =
                engine() % (input.size() + 1);
            if (!switch_points.empty()
                && point < switch_points.back()) {
                continue;
            }
            convolver.switch_response(next, point);
            responses.push_back(std::move(next));
            switch_points.push_back(point);
        }

        std::vector<std::size_t> push_chunks;
        std::vector<std::size_t> pull_chunks;
        for (int i = 0; i < 5; ++i) {
            push_chunks.push_back(engine() % 9);
            pull_chunks.push_back(engine() % 8);
        }
        auto output = run_stream(
            convolver, input, push_chunks, pull_chunks, engine);
        auto reference = reference_switched_convolution(
            input, responses, switch_points);
        compare_with_bound(
            output, reference,
            spatial_audio::kScaledErrorBound(1.0, max_response),
            "fuzz trial " + std::to_string(trial));
        CHECK_TRUE(output.size() == reference.size(),
                   "fuzz trial output length");
    }
}

void test_fft_itself() {
    constexpr std::size_t N = 64;
    FftPlan plan(N);
    std::vector<Complex> signal(N, Complex{});
    std::mt19937 engine(12345);
    for (Complex& sample : signal) {
        sample = Complex(pseudo_random(engine, 1.0),
                         pseudo_random(engine, 1.0));
    }
    const std::vector<Complex> original = signal;
    std::vector<Complex> naive(N, Complex{});
    constexpr double kPi = 3.14159265358979323846;
    for (std::size_t k = 0; k < N; ++k) {
        Complex sum(0.0, 0.0);
        for (std::size_t n = 0; n < N; ++n) {
            const double angle = -2.0 * kPi
                                 * static_cast<double>(k * n)
                                 / static_cast<double>(N);
            sum += original[n]
                   * Complex(std::cos(angle), std::sin(angle));
        }
        naive[k] = sum;
    }
    plan.forward(signal);
    double forward_error = 0.0;
    for (std::size_t i = 0; i < N; ++i) {
        forward_error =
            std::max(forward_error, std::abs(signal[i] - naive[i]));
    }
    std::printf("[fft-forward] max absolute error = %.3e\n",
                forward_error);
    CHECK_TRUE(forward_error <= 1e-12,
               "forward FFT matches naive DFT");

    plan.inverse(signal);
    double roundtrip_error = 0.0;
    for (std::size_t i = 0; i < N; ++i) {
        roundtrip_error = std::max(
            roundtrip_error, std::abs(signal[i] - original[i]));
    }
    std::printf("[fft-roundtrip] max absolute error = %.3e\n",
                roundtrip_error);
    CHECK_TRUE(roundtrip_error <= 1e-14,
               "FFT inverse reconstructs signal");
}

void test_empty_input() {
    StreamingConvolver convolver(8, 16);
    convolver.set_initial_response({1.0, 0.5, 0.25});
    convolver.push({});
    convolver.finish();
    std::vector<double> output;
    CHECK_TRUE(convolver.pull(output, 100) == 0,
               "empty input yields empty output");
    CHECK_TRUE(convolver.expected_total_output() == 0,
               "empty input total length is zero");
}

void test_basic_linear_convolution() {
    const std::vector<double> input =
        {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    const std::vector<double> response = {1, -1, 0.5, 0.25};
    auto reference =
        reference_switched_convolution(input, {response}, {});

    for (std::size_t partition : {4u, 8u, 16u}) {
        StreamingConvolver convolver(partition, 16);
        convolver.set_initial_response(response);
        std::mt19937 engine(7);
        auto output = run_stream(
            convolver, input, {1, 3, 2, 5, 1}, {0, 1, 2, 4, 7}, engine);
        compare_with_bound(
            output, reference,
            spatial_audio::kScaledErrorBound(10.0, 16),
            "basic P=" + std::to_string(partition));
        CHECK_TRUE(output.size() == input.size() + response.size() - 1,
                   "linear output has N+M-1 samples");
    }
}

void test_impulse_and_delta() {
    const std::size_t count = 40;
    StreamingConvolver delta(4, 64);
    delta.set_initial_response({1.0});
    std::mt19937 engine(99);
    std::vector<double> impulse(count, 0.0);
    impulse[0] = 1.0;
    auto identity_out =
        run_stream(delta, impulse, {3, 3, 1}, {2, 2, 5}, engine);
    compare_with_bound(identity_out, impulse,
                       spatial_audio::kUnitAmplitudeErrorBound,
                       "delta response reproduces input");

    std::vector<double> arbitrary;
    for (std::size_t i = 0; i < count; ++i) {
        arbitrary.push_back(std::sin(static_cast<double>(i) * 0.37));
    }
    // A unit impulse as the impulse response reproduces the input exactly.
    StreamingConvolver impulse_filter(8, 64);
    impulse_filter.set_initial_response({1.0});
    auto filtered = run_stream(
        impulse_filter, arbitrary, {5, 7, 2, 11}, {3, 9}, engine);
    compare_with_bound(filtered, arbitrary,
                       spatial_audio::kUnitAmplitudeErrorBound,
                       "impulse IR reproduces input");
}

void test_long_tail() {
    std::vector<double> response(61);
    for (std::size_t i = 0; i < response.size(); ++i) {
        response[i] =
            std::exp(-static_cast<double>(i) / 9.0)
            * std::cos(static_cast<double>(i) * 0.55);
    }
    std::vector<double> input(25);
    std::mt19937 engine(2026);
    for (double& sample : input) {
        sample = pseudo_random(engine, 1.0);
    }
    auto reference =
        reference_switched_convolution(input, {response}, {});

    StreamingConvolver convolver(8, 64);
    convolver.set_initial_response(response);
    auto output = run_stream(
        convolver, input, {1, 2, 4, 8, 3}, {2, 6, 1}, engine);
    compare_with_bound(
        output, reference,
        spatial_audio::kScaledErrorBound(1.0, 64),
        "long tail P=8 M=61");

    StreamingConvolver wide(32, 64);
    wide.set_initial_response(response);
    auto wide_output =
        run_stream(wide, input, {3, 7, 5}, {4, 4, 4}, engine);
    compare_with_bound(
        wide_output, reference,
        spatial_audio::kScaledErrorBound(1.0, 64),
        "long tail P=32 M=61");
}

} // namespace

int main() {
    #define RUN_TEST(name)                               \
        do {                                             \
            std::printf("--- %s\n", #name);              \
            std::fflush(stdout);                         \
            name();                                      \
        } while (0)
    RUN_TEST(test_fft_itself);
    RUN_TEST(test_empty_input);
    RUN_TEST(test_basic_linear_convolution);
    RUN_TEST(test_impulse_and_delta);
    RUN_TEST(test_long_tail);
    RUN_TEST(test_switch_exact_boundary);
    RUN_TEST(test_switch_inside_block_uses_history);
    RUN_TEST(test_switch_at_stream_end);
    RUN_TEST(test_pause_and_backpressure);
    RUN_TEST(test_validation_errors);
    RUN_TEST(test_max_length_new_filter_uses_full_history);
    RUN_TEST(test_randomized_fuzz);
    #undef RUN_TEST

    if (g_failures == 0) {
        std::printf("\nAll tests passed.\n");
        return 0;
    }
    std::printf("\n%d test check(s) failed.\n", g_failures);
    return 1;
}
