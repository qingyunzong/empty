#include <cstdint>
#include <iomanip>
#include <iostream>
#include <string>

#include "simulator.hpp"

int main() {
    using namespace netsim;

    Simulator sim;
    const int lan = sim.add_link(4);   // 4 bytes/tick
    const int wan = sim.add_link(2);   // 2 bytes/tick

    sim.add_flow(1, {lan}, 10, 0);        // single hop
    sim.add_flow(2, {lan, wan}, 8, 0);    // multi hop
    sim.add_flow(3, {wan}, 6, 2);         // joins at tick 3
    sim.cancel_flow(1, 4);                // revokes flow 1's unsent bytes at tick 4

    constexpr Tick kMaxTicks = 1000;
    sim.run(kMaxTicks);
    if (!sim.finished()) {
        std::cerr << "simulation did not finish within " << kMaxTicks << " ticks\n";
        return 1;
    }

    std::cout << "events (first 12 of " << sim.events().size() << "):\n";
    std::cout << "  tick  flow  link  byte\n";
    const std::size_t shown = std::min<std::size_t>(12, sim.events().size());
    for (std::size_t i = 0; i < shown; ++i) {
        const ByteEvent& e = sim.events()[i];
        std::cout << "  " << std::setw(4) << e.tick << "  " << std::setw(4) << e.flow_id << "  "
                  << std::setw(4) << e.link_id << "  " << std::setw(4) << e.byte_index << "\n";
    }

    std::cout << "\nflow accounting:\n";
    std::cout << "  id   size  delivered  cancelled  in_flight  unsent  done  completion_tick\n";
    std::uint64_t tot_size = 0, tot_delivered = 0, tot_cancelled = 0, tot_flight = 0, tot_unsent = 0;
    for (const FlowAccounting& a : sim.accounting()) {
        std::cout << "  " << std::setw(3) << a.flow_id << "  " << std::setw(5) << a.size << "  "
                  << std::setw(9) << a.delivered << "  " << std::setw(9) << a.cancelled << "  "
                  << std::setw(9) << a.in_flight << "  " << std::setw(7) << a.unsent << "  "
                  << std::setw(4) << (a.completed ? "yes" : "no") << "  " << std::setw(15)
                  << a.completion_tick << "\n";
        tot_size += a.size;
        tot_delivered += a.delivered;
        tot_cancelled += a.cancelled;
        tot_flight += a.in_flight;
        tot_unsent += a.unsent;
    }

    std::cout << "\ntotals: injected=" << tot_size << " delivered=" << tot_delivered
              << " cancelled=" << tot_cancelled << " in_flight=" << tot_flight
              << " unsent=" << tot_unsent << "\n";

    std::string error;
    if (!sim.check_conservation(error)) {
        std::cerr << "conservation check FAILED: " << error << "\n";
        return 1;
    }
    std::cout << "conservation: OK (delivered + cancelled + in_flight + unsent == injected)\n";
    return 0;
}
