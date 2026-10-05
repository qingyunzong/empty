#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace gatesim {

enum class Logic : std::uint8_t { Low = 0, High = 1 };

enum class GateKind { Not, And, Or, Xor, Nand, Nor };

struct Change {
    std::uint64_t time;
    std::uint32_t delta;
    Logic value;
    std::string reason;
};

struct Signal {
    std::string name;
    Logic value = Logic::Low;
    std::vector<Change> history;
};

class Simulator {
public:
    static constexpr std::uint32_t max_delta = 1000;

    std::size_t add_signal(std::string name, Logic init = Logic::Low);
    std::size_t add_gate(GateKind kind, std::vector<std::size_t> inputs,
                         std::size_t output, std::uint64_t delay);
    void set_input(std::size_t sig, std::uint64_t time, Logic value);
    void run();

    [[nodiscard]] const Signal& signal(std::size_t id) const { return signals_.at(id); }
    [[nodiscard]] Logic value_at(std::size_t sig, std::uint64_t time) const;
    [[nodiscard]] const std::vector<std::string>& log() const { return log_; }
    [[nodiscard]] std::string waveform_text(std::size_t sig) const;

private:
    struct Gate {
        GateKind kind;
        std::vector<std::size_t> inputs;
        std::size_t output;
        std::uint64_t delay;
        std::uint64_t token = 0;
        bool has_pending = false;
    };

    struct Event {
        std::size_t gate;
        std::uint64_t token;
        Logic value;
    };

    std::vector<Signal> signals_;
    std::vector<Gate> gates_;
    std::map<std::uint64_t, std::vector<Event>> events_;
    std::map<std::uint64_t, std::vector<std::pair<std::size_t, Logic>>> stimulus_;
    std::vector<std::string> log_;
    std::uint64_t now_ = 0;

    Logic eval(const Gate& g) const;
    void apply_change(std::size_t sig, Logic v, std::uint32_t delta, std::string reason,
                      std::vector<bool>& dirty);
    void update_inertial(std::size_t gi, Logic v);
    void settle(std::vector<bool>& dirty);
    std::string gate_name(std::size_t gi) const;
};

const char* to_string(GateKind kind);
char to_char(Logic v);

} // namespace gatesim
