#include "model.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

void print_cycle(const lw::Cycle& cycle, std::ostream& out) {
    out << "shortest deadlock cycle: " << cycle.threads.size()
        << " thread(s)\n";
    for (const auto& t : cycle.threads)
        out << "  " << t;
    out << "  (back to " << cycle.threads.front() << ")\n";
    for (const lw::Edge& e : cycle.edges) {
        out << "  " << e.from << " waits on " << e.lock << " ("
            << lw::to_string(e.wait_mode) << ", call " << e.waiter_call
            << ", requested at event #" << e.waiter_req_event << ")\n"
            << "    blocked by " << e.to << " holding " << e.lock << " ("
            << lw::to_string(e.hold_mode) << ", call " << e.holder_call
            << ", granted at event #" << e.holder_grant_event << ")\n";
    }
}

std::string describe_event(const lw::Event& ev) {
    std::ostringstream s;
    s << "#" << ev.index << " [t=" << ev.time << "] ";
    switch (ev.op) {
    case lw::OpType::Request:
        s << "REQ " << ev.thread << " " << ev.call << " " << ev.lock << " "
          << lw::to_string(ev.mode);
        break;
    case lw::OpType::Grant:
        s << "GNT " << ev.call;
        break;
    case lw::OpType::Release:
        s << "REL " << ev.call;
        break;
    case lw::OpType::Cancel:
        s << "CAN " << ev.call;
        break;
    }
    return s.str();
}

} // namespace

int main(int argc, char** argv) {
    bool verify = true;
    std::string path = "-";
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--no-verify")
            verify = false;
        else if (arg == "--help" || arg == "-h") {
            std::cout << "usage: lockwait-diag [--no-verify] [logfile|-]\n"
                         "log format (one event per line, '#' comments):\n"
                         "  REQ <time> <thread> <call> <lock> <S|X>\n"
                         "  GNT <time> <call>\n"
                         "  REL <time> <call>\n"
                         "  CAN <time> <call>\n"
                         "exit code: 0 = no deadlock, 1 = deadlock found, "
                         "2 = error\n";
            return 0;
        } else {
            path = arg;
        }
    }

    std::ifstream file;
    std::istream* in = &std::cin;
    if (path != "-") {
        file.open(path);
        if (!file) {
            std::cerr << "error: cannot open '" << path << "'\n";
            return 2;
        }
        in = &file;
    }

    lw::Engine engine(verify);
    std::optional<lw::Cycle> first_deadlock;
    lw::Event first_event;
    std::string line;
    std::size_t index = 0;
    std::size_t events = 0;
    while (std::getline(*in, line)) {
        ++index;
        lw::Event ev;
        bool skip = false;
        std::string err;
        if (!lw::parse_line(line, index, ev, skip, err)) {
            std::cerr << "parse error: " << err << "\n";
            return 2;
        }
        if (skip)
            continue;
        ev.index = events + 1; // ordinal among events, not line number
        if (!engine.apply(ev, err)) {
            std::cerr << "error: " << err << "\n";
            return 2;
        }
        ++events;
        if (!first_deadlock) {
            if (auto cycle = engine.model().shortest_cycle()) {
                first_deadlock = *cycle;
                first_event = ev;
            }
        }
    }

    if (verify)
        std::cout << "per-moment full-graph verification: OK ("
                  << engine.moments_verified() << " of " << events
                  << " moments)\n";

    if (first_deadlock) {
        std::cout << "DEADLOCK first detected at event "
                  << describe_event(first_event) << "\n";
        print_cycle(*first_deadlock, std::cout);
        return 1;
    }

    std::cout << "no deadlock in " << events << " event(s)\n";
    return 0;
}
