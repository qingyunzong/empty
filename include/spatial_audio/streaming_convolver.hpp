#pragma once

#include <complex>
#include <cstddef>
#include <deque>
#include <vector>

#include "spatial_audio/fft.hpp"

namespace spatial_audio {

// Declared numerical contract for unit-amplitude workloads.
//
// Every emitted sample of the partitioned overlap-add engine is compared
// against a direct time-domain reference in the test suite, which asserts the
// measured maximum absolute error stays below this bound. For larger signal
// levels the bound scales linearly; see kScaledErrorBound() below.
constexpr double kUnitAmplitudeErrorBound = 1e-9;

inline double kScaledErrorBound(double amplitude, std::size_t maxResponseLength) {
    return kUnitAmplitudeErrorBound * amplitude
           * static_cast<double>(maxResponseLength);
}

// Uniform-partition overlap-add streaming linear convolver.
//
// - partition_length P must be a positive power of two; the FFT size is 2P,
//   which is strictly larger than every per-partition linear convolution
//   (length 2P-1), so block boundaries never wrap into circular convolution.
// - The impulse response may be much longer than an input block: it is split
//   into uniform P-sample partitions.
// - push() accepts blocks of any length; samples are accumulated into
//   P-sample processing blocks internally.
// - pull() drains an output FIFO and returns 0 when no output is available,
//   letting the caller apply backpressure without losing input.
// - switch_response() installs a new filter at an absolute input-sample index;
//   the new lane is warmed from the retained input history (spectra), never
//   from a reset state.
class StreamingConvolver {
public:
    StreamingConvolver(std::size_t partition_length,
                       std::size_t max_response_length);

    // Mandatory before the first push. May also be called only while no input
    // has been pushed. Throws on an empty response or a response longer than
    // the configured maximum.
    void set_initial_response(const std::vector<double>& response);

    // Schedule replacing the active impulse response. The new filter governs
    // output sample n (n counted over the whole input stream) exactly when
    // n >= switch_sample_index, while earlier samples keep the old filter.
    //
    // switch_sample_index must not be before the end of the already pushed
    // stream and switch indices must be non-decreasing. The response must be
    // non-empty and no longer than max_response_length. Throws std::logic_error
    // or std::invalid_argument on violations.
    void switch_response(const std::vector<double>& response,
                         std::size_t switch_sample_index);

    // Accepts any number of samples, including zero (a no-op). Finishing is
    // not allowed afterwards.
    void push(const std::vector<double>& input);

    // Copies up to requested_count ready samples into output (resized to the
    // number actually delivered). Returns that number; 0 means "try again
    // later", which is the backpressure/idle signal.
    std::size_t pull(std::vector<double>& output, std::size_t requested_count);

    // Marks the stream complete, processes the final partial block and the
    // filter tail. After this call exactly input_count + current M - 1 samples
    // will be produced in total (zero for empty input).
    void finish();

    bool finished() const noexcept { return finished_; }
    std::size_t input_count() const noexcept { return total_input_; }
    std::size_t output_emitted() const noexcept { return total_emitted_; }
    std::size_t output_available() const noexcept { return output_fifo_.size(); }
    std::size_t partition_length() const noexcept { return partition_length_; }
    std::size_t max_response_length() const noexcept { return max_response_length_; }

    // Total output samples the finished stream will contain. Undefined before
    // finish() because the final response can still change.
    std::size_t expected_total_output() const;

private:
    struct Lane {
        std::size_t response_length;
        std::size_t partition_count;
        std::vector<std::vector<Complex>> partition_spectra;
        std::vector<double> overlap;
        std::size_t next_block; // next P-sample block index this lane emits
    };

    struct ScheduledSwitch {
        std::size_t lane_id;
        std::size_t sample_index;
    };

    std::size_t create_lane(const std::vector<double>& response);
    void process_full_blocks();
    void emit_output_block(std::size_t block_index);
    void emit_lane(Lane& lane, std::size_t block_index,
                   std::vector<Complex>& accumulator);
    void warm_start(Lane& lane, std::size_t block_index);
    const std::vector<Complex>* find_spectrum(std::size_t block_index) const;
    void store_spectrum(std::size_t block_index, std::vector<Complex> spectrum);
    void validate_response(const std::vector<double>& response) const;

    std::size_t partition_length_;
    std::size_t fft_size_;
    std::size_t max_response_length_;
    std::size_t max_partitions_;

    FftPlan fft_;

    std::vector<double> input_accumulator_;
    std::size_t total_input_ = 0;
    std::size_t blocks_pushed_ = 0;

    // Ring of retained input-block spectra; depth K_max + 1 covers warm start
    // of the longest allowed response (which needs K_max historical blocks).
    std::vector<std::vector<Complex>> spectrum_ring_;
    std::vector<std::ptrdiff_t> ring_block_id_;

    std::vector<Lane> lanes_;
    std::deque<ScheduledSwitch> switches_;
    std::size_t current_lane_ = 0;

    std::deque<double> output_fifo_;
    std::size_t total_emitted_ = 0;
    bool finished_ = false;
};

} // namespace spatial_audio
