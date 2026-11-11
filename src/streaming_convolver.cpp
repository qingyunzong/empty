#include "spatial_audio/streaming_convolver.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace spatial_audio {

StreamingConvolver::StreamingConvolver(std::size_t partition_length,
                                       std::size_t max_response_length)
    : partition_length_(0),
      fft_size_(0),
      max_response_length_(0),
      max_partitions_(0),
      fft_(1) {
    if (partition_length == 0
        || (partition_length & (partition_length - 1)) != 0) {
        throw std::invalid_argument(
            "partition_length must be a positive power of two");
    }
    if (max_response_length == 0) {
        throw std::invalid_argument(
            "max_response_length must be greater than zero");
    }

    partition_length_ = partition_length;
    fft_size_ = 2 * partition_length;
    max_response_length_ = max_response_length;
    max_partitions_ =
        (max_response_length + partition_length - 1) / partition_length;
    fft_ = FftPlan(fft_size_);
    spectrum_ring_.assign(max_partitions_ + 1,
                          std::vector<Complex>(fft_size_, Complex{}));
    ring_block_id_.assign(max_partitions_ + 1, -1);
}

void StreamingConvolver::validate_response(
    const std::vector<double>& response) const {
    if (response.empty()) {
        throw std::invalid_argument("impulse response must not be empty");
    }
    if (response.size() > max_response_length_) {
        throw std::invalid_argument(
            "impulse response exceeds configured maximum length");
    }
}

std::size_t StreamingConvolver::create_lane(
    const std::vector<double>& response) {
    validate_response(response);

    Lane lane;
    lane.response_length = response.size();
    lane.partition_count =
        (response.size() + partition_length_ - 1) / partition_length_;
    lane.partition_spectra.resize(lane.partition_count,
                                  std::vector<Complex>(fft_size_, Complex{}));
    lane.overlap.assign(partition_length_, 0.0);
    lane.next_block = 0;

    std::vector<Complex> padded(fft_size_, Complex{});
    for (std::size_t q = 0; q < lane.partition_count; ++q) {
        std::fill(padded.begin(), padded.end(), Complex{});
        const std::size_t offset = q * partition_length_;
        const std::size_t count =
            std::min(partition_length_, response.size() - offset);
        for (std::size_t j = 0; j < count; ++j) {
            padded[j] = Complex(response[offset + j], 0.0);
        }
        fft_.forward(padded);
        lane.partition_spectra[q] = padded;
    }

    lanes_.push_back(std::move(lane));
    return lanes_.size() - 1;
}

void StreamingConvolver::set_initial_response(
    const std::vector<double>& response) {
    if (finished_) {
        throw std::logic_error("convolver has already been finished");
    }
    if (total_input_ != 0) {
        throw std::logic_error(
            "initial response can only be set before the first push");
    }
    if (!lanes_.empty()) {
        throw std::logic_error("initial response has already been set");
    }
    create_lane(response);
    current_lane_ = 0;
}

void StreamingConvolver::switch_response(
    const std::vector<double>& response,
    std::size_t switch_sample_index) {
    if (finished_) {
        throw std::logic_error("convolver has already been finished");
    }
    if (lanes_.empty()) {
        throw std::logic_error(
            "set_initial_response must be called before switching responses");
    }
    if (switch_sample_index < total_input_) {
        throw std::invalid_argument(
            "switch sample index lies in the already consumed past");
    }
    if (!switches_.empty()
        && switch_sample_index < switches_.back().sample_index) {
        throw std::invalid_argument(
            "switch sample indices must be non-decreasing");
    }

    const std::size_t lane_id = create_lane(response);
    switches_.push_back(ScheduledSwitch{lane_id, switch_sample_index});
}

void StreamingConvolver::store_spectrum(std::size_t block_index,
                                        std::vector<Complex> spectrum) {
    const std::size_t slot = block_index % spectrum_ring_.size();
    spectrum_ring_[slot] = std::move(spectrum);
    ring_block_id_[slot] = static_cast<std::ptrdiff_t>(block_index);
}

const std::vector<Complex>* StreamingConvolver::find_spectrum(
    std::size_t block_index) const {
    const std::size_t slot = block_index % spectrum_ring_.size();
    if (ring_block_id_[slot] == static_cast<std::ptrdiff_t>(block_index)) {
        return &spectrum_ring_[slot];
    }
    return nullptr;
}

void StreamingConvolver::warm_start(Lane& lane, std::size_t block_index) {
    // A lane first activated at block b must continue the linear convolution
    // using retained input history rather than a reset state. Its initial
    // overlap is the second half (samples P..2P-1) of D_{b-1}, where
    // D_r = IFFT( sum_q X_{r-q} H_q ). The q=0 term (the immediately
    // preceding input block convolved with the first response partition) is
    // required and must not be skipped.
    std::vector<Complex> accumulator(fft_size_, Complex{});
    for (std::size_t q = 0; q < lane.partition_count; ++q) {
        if (q > block_index) {
            break; // r = b - q would be negative
        }
        const std::size_t r = block_index - 1 - q;
        const std::vector<Complex>* input_spectrum = find_spectrum(r);
        if (input_spectrum == nullptr) {
            continue;
        }
        for (std::size_t i = 0; i < fft_size_; ++i) {
            accumulator[i] +=
                (*input_spectrum)[i] * lane.partition_spectra[q][i];
        }
    }
    fft_.inverse(accumulator);
    for (std::size_t j = 0; j < partition_length_; ++j) {
        lane.overlap[j] = accumulator[partition_length_ + j].real();
    }
    lane.next_block = block_index;
}

void StreamingConvolver::emit_lane(Lane& lane, std::size_t block_index,
                                   std::vector<Complex>& accumulator) {
    if (lane.next_block == 0 && block_index > 0) {
        warm_start(lane, block_index);
    }
    if (lane.next_block != block_index) {
        throw std::logic_error(
            "internal error: lane emission skipped a block");
    }

    std::vector<Complex> product(fft_size_, Complex{});
    for (std::size_t q = 0; q < lane.partition_count; ++q) {
        if (q > block_index) {
            break; // no input block r = b - q exists
        }
        const std::vector<Complex>* input_spectrum =
            find_spectrum(block_index - q);
        if (input_spectrum == nullptr) {
            continue;
        }
        for (std::size_t i = 0; i < fft_size_; ++i) {
            product[i] +=
                (*input_spectrum)[i] * lane.partition_spectra[q][i];
        }
    }
    fft_.inverse(product);

    for (std::size_t j = 0; j < partition_length_; ++j) {
        accumulator[j] +=
            Complex(product[j].real() + lane.overlap[j], 0.0);
    }
    for (std::size_t j = 0; j < partition_length_; ++j) {
        lane.overlap[j] = product[partition_length_ + j].real();
    }
    lane.next_block = block_index + 1;
}

void StreamingConvolver::emit_output_block(std::size_t block_index) {
    // Even the final zero-padded block carries real samples and its spectrum
    // must remain visible to lanes first activated inside this block.
    std::vector<Complex> block_spectrum(fft_size_, Complex{});
    const std::size_t real_count = std::min(
        partition_length_, input_accumulator_.size());
    for (std::size_t j = 0; j < real_count; ++j) {
        block_spectrum[j] = Complex(input_accumulator_[j], 0.0);
    }
    fft_.forward(block_spectrum);
    store_spectrum(block_index, std::move(block_spectrum));

    const std::size_t block_start = block_index * partition_length_;
    const std::size_t block_end = block_start + partition_length_;

    while (!switches_.empty()
           && switches_.front().sample_index <= block_start) {
        current_lane_ = switches_.front().lane_id;
        switches_.pop_front();
    }

    struct IntraSwitch {
        std::size_t offset;
        std::size_t lane_id;
    };
    std::vector<IntraSwitch> intra;
    for (const ScheduledSwitch& scheduled : switches_) {
        if (scheduled.sample_index >= block_end) {
            break;
        }
        intra.push_back(
            IntraSwitch{scheduled.sample_index - block_start,
                        scheduled.lane_id});
    }

    std::vector<std::vector<Complex>> lane_outputs(lanes_.size());
    auto get_output = [&](std::size_t lane_id) -> std::vector<Complex>& {
        if (lane_outputs[lane_id].empty()) {
            lane_outputs[lane_id].assign(fft_size_, Complex{});
            emit_lane(lanes_[lane_id], block_index, lane_outputs[lane_id]);
        }
        return lane_outputs[lane_id];
    };

    std::size_t segment_start = 0;
    std::size_t active_lane = current_lane_;
    for (const IntraSwitch& change : intra) {
        const std::vector<Complex>& before = get_output(active_lane);
        for (std::size_t j = segment_start; j < change.offset; ++j) {
            output_fifo_.push_back(before[j].real());
        }
        active_lane = change.lane_id;
        segment_start = change.offset;
    }
    const std::vector<Complex>& tail = get_output(active_lane);
    for (std::size_t j = segment_start; j < partition_length_; ++j) {
        output_fifo_.push_back(tail[j].real());
    }
    current_lane_ = active_lane;
}

void StreamingConvolver::process_full_blocks() {
    while (input_accumulator_.size() >= partition_length_) {
        emit_output_block(blocks_pushed_);
        ++blocks_pushed_;
        input_accumulator_.erase(
            input_accumulator_.begin(),
            input_accumulator_.begin()
                + static_cast<std::ptrdiff_t>(partition_length_));
    }
}

void StreamingConvolver::push(const std::vector<double>& input) {
    if (finished_) {
        throw std::logic_error("cannot push after finish");
    }
    if (lanes_.empty()) {
        throw std::logic_error(
            "set_initial_response must be called before the first push");
    }
    if (input.empty()) {
        return;
    }
    total_input_ += input.size();
    input_accumulator_.insert(input_accumulator_.end(),
                              input.begin(), input.end());
    process_full_blocks();
}

std::size_t StreamingConvolver::pull(std::vector<double>& output,
                                     std::size_t requested_count) {
    output.clear();
    const std::size_t count =
        std::min(requested_count, output_fifo_.size());
    for (std::size_t i = 0; i < count; ++i) {
        output.push_back(output_fifo_.front());
        output_fifo_.pop_front();
    }
    total_emitted_ += count;
    return count;
}

void StreamingConvolver::finish() {
    if (finished_) {
        return;
    }
    finished_ = true;

    // Empty input must produce empty output, regardless of response length.
    if (total_input_ == 0) {
        return;
    }

    if (!input_accumulator_.empty()) {
        emit_output_block(blocks_pushed_);
        ++blocks_pushed_;
        input_accumulator_.clear();
    }

    std::size_t last_lane = current_lane_;
    for (const ScheduledSwitch& scheduled : switches_) {
        if (scheduled.sample_index <= total_input_) {
            last_lane = scheduled.lane_id;
        }
    }

    const std::size_t target_output =
        total_input_ + lanes_[last_lane].response_length - 1;

    std::size_t block_index = blocks_pushed_;
    while (total_emitted_ + output_fifo_.size() < target_output) {
        std::vector<Complex> zero_output(fft_size_, Complex{});
        emit_lane(lanes_[last_lane], block_index, zero_output);
        ++block_index;
        for (std::size_t j = 0; j < partition_length_; ++j) {
            output_fifo_.push_back(zero_output[j].real());
        }
    }

    while (output_fifo_.size()
           > target_output - std::min(target_output, total_emitted_)) {
        output_fifo_.pop_back();
    }
}

std::size_t StreamingConvolver::expected_total_output() const {
    if (!finished_) {
        throw std::logic_error(
            "total output length is only defined after finish");
    }
    return total_emitted_ + output_fifo_.size();
}

} // namespace spatial_audio
