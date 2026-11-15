#include "dataeng.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct Options {
    bool json = false;
    bool check = false;
    bool repairs_only = false;
    bool parse_only = false;
    bool strict = false;
    bool require_digest = false;
    bool verify_digests = true;
    bool require_request = true;
    std::string output;
    std::vector<std::string> inputs;
};

std::string json_quote(std::string_view value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20) {
                    static constexpr char kHex[] = "0123456789abcdef";
                    out += "\\u00";
                    out.push_back(kHex[c >> 4]);
                    out.push_back(kHex[c & 0x0f]);
                } else {
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    out.push_back('"');
    return out;
}

void print_usage(std::ostream& out) {
    out << "usage: warc-assemble [options] [FILE ...]\n"
           "\n"
           "Assemble WARC request/response/revisit/metadata records and verify\n"
           "segmented blocks.  With no FILE, reads standard input.\n"
           "\n"
           "options:\n"
           "  --json                 emit the complete assembly report as JSON\n"
           "  --repairs              emit only the repair checklist and missing links\n"
           "  --check                report problems without the full report\n"
           "  --parse-only           parse records without assembling exchanges\n"
           "  --require-digest       require a block or payload digest per record\n"
           "  --no-digest-check      do not verify digest values\n"
           "  --allow-missing-request\n"
           "                         do not mark response/revisit without request\n"
           "  --strict               make warnings affect the exit status\n"
           "  -o, --output FILE      write the report to FILE\n"
           "  -h, --help             show this help\n"
           "  --version              show the library version\n";
}

bool read_stream(std::istream& input, std::string& output) {
    std::ostringstream buffer;
    buffer << input.rdbuf();
    if (input.bad()) {
        return false;
    }
    output = buffer.str();
    return true;
}

std::string record_label(const dataeng::Assembly& assembly, std::size_t index) {
    if (index >= assembly.records.size()) {
        return "<logical-record:" + std::to_string(index) + ">";
    }
    std::string id = assembly.records[index].id();
    if (id.empty()) {
        id = "<stream-index:" + std::to_string(index) + ">";
    }
    return id;
}

void print_diagnostics(std::ostream& out,
                       const std::vector<dataeng::Diagnostic>& diagnostics) {
    for (const dataeng::Diagnostic& diagnostic : diagnostics) {
        out << "  [" << dataeng::to_string(diagnostic.severity) << "] "
            << diagnostic.code << ": " << diagnostic.message;
        if (!diagnostic.record_id.empty()) {
            out << " (record " << diagnostic.record_id << ")";
        }
        out << '\n';
    }
}

void print_text_report(std::ostream& out, const dataeng::Assembly& assembly,
                       bool repairs_only) {
    std::size_t complete_exchanges = 0;
    for (const dataeng::Exchange& exchange : assembly.exchanges) {
        if (exchange.complete) {
            ++complete_exchanges;
        }
    }

    if (!repairs_only) {
        out << "records: " << assembly.records.size()
            << ", logical: " << assembly.logical_records.size()
            << ", exchanges: " << assembly.exchanges.size() << " ("
            << complete_exchanges << " complete)\n";
        out << "status: " << (assembly.complete() ? "complete" : "incomplete")
            << '\n';
        if (!assembly.parse_diagnostics.empty()) {
            out << "parse diagnostics:\n";
            print_diagnostics(out, assembly.parse_diagnostics);
        }
        if (!assembly.diagnostics.empty()) {
            out << "assembly diagnostics:\n";
            print_diagnostics(out, assembly.diagnostics);
        }
        if (!assembly.exchanges.empty()) {
            out << "exchanges:\n";
            for (const dataeng::Exchange& exchange : assembly.exchanges) {
                out << "  " << exchange.id << ": "
                    << (exchange.complete ? "complete" : "incomplete");
                if (exchange.response) {
                    out << " response="
                        << record_label(assembly, exchange.response.value());
                }
                if (exchange.revisit) {
                    out << " revisit="
                        << record_label(assembly, exchange.revisit.value());
                }
                if (!exchange.requests.empty()) {
                    out << " requests=";
                    for (std::size_t i = 0; i < exchange.requests.size(); ++i) {
                        if (i != 0) {
                            out << ',';
                        }
                        std::size_t logical_index = exchange.requests[i];
                        if (logical_index < assembly.logical_records.size()) {
                            out << assembly.logical_records[logical_index].id;
                        }
                    }
                }
                out << '\n';
            }
        }
    }

    if (!assembly.missing_links.empty()) {
        out << "missing links:\n";
        for (const dataeng::MissingLink& missing : assembly.missing_links) {
            out << "  " << missing.kind;
            if (!missing.record_id.empty()) {
                out << " from " << missing.record_id;
            }
            if (!missing.reference.empty()) {
                out << " -> " << missing.reference;
            }
            out << ": " << missing.reason << '\n';
        }
    }
    if (!assembly.repairs.empty()) {
        out << "repair checklist:\n";
        for (const dataeng::RepairAction& repair : assembly.repairs) {
            out << "  - [" << repair.code << "]";
            if (!repair.record_id.empty()) {
                out << " " << repair.record_id;
            }
            if (!repair.missing_id.empty()) {
                out << " missing " << repair.missing_id;
            }
            out << "\n    " << repair.action << '\n';
            if (!repair.detail.empty()) {
                out << "    why: " << repair.detail << '\n';
            }
        }
    }
}

bool parse_arguments(int argc, char** argv, Options& options,
                     std::string& error) {
    for (int i = 1; i < argc; ++i) {
        std::string argument = argv[i];
        if (argument == "--json") {
            options.json = true;
        } else if (argument == "--check") {
            options.check = true;
        } else if (argument == "--repairs") {
            options.repairs_only = true;
        } else if (argument == "--parse-only") {
            options.parse_only = true;
        } else if (argument == "--require-digest") {
            options.require_digest = true;
        } else if (argument == "--no-digest-check") {
            options.verify_digests = false;
        } else if (argument == "--allow-missing-request") {
            options.require_request = false;
        } else if (argument == "--strict") {
            options.strict = true;
        } else if (argument == "--version") {
            std::cout << "dataeng WARC assembler 1.0.0\n";
            std::exit(0);
        } else if (argument == "-h" || argument == "--help") {
            print_usage(std::cout);
            std::exit(0);
        } else if (argument == "-o" || argument == "--output") {
            if (i + 1 >= argc) {
                error = argument + " needs a file name";
                return false;
            }
            options.output = argv[++i];
        } else if (!argument.empty() && argument.front() == '-') {
            error = "unknown option: " + argument;
            return false;
        } else {
            options.inputs.push_back(argument);
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    Options options;
    std::string argument_error;
    if (!parse_arguments(argc, argv, options, argument_error)) {
        std::cerr << "warc-assemble: " << argument_error << '\n';
        print_usage(std::cerr);
        return 1;
    }

    std::vector<std::string> buffers;
    if (options.inputs.empty()) {
        std::string buffer;
        if (!read_stream(std::cin, buffer)) {
            std::cerr << "warc-assemble: failed to read standard input\n";
            return 1;
        }
        buffers.push_back(std::move(buffer));
    } else {
        for (const std::string& path : options.inputs) {
            std::ifstream file(path, std::ios::binary);
            if (!file) {
                std::cerr << "warc-assemble: cannot open " << path << '\n';
                return 1;
            }
            std::string buffer;
            if (!read_stream(file, buffer)) {
                std::cerr << "warc-assemble: failed to read " << path << '\n';
                return 1;
            }
            buffers.push_back(std::move(buffer));
        }
    }

    dataeng::ParseOptions parse_options;
    dataeng::AssembleOptions assemble_options;
    assemble_options.verify_digests = options.verify_digests;
    assemble_options.require_digest = options.require_digest;
    assemble_options.require_request = options.require_request;

    std::vector<dataeng::Record> records;
    std::vector<dataeng::Diagnostic> parse_diagnostics;
    for (std::string& buffer : buffers) {
        std::size_t record_base = records.size();
        dataeng::ParseResult parsed =
            dataeng::parse_warc(buffer, parse_options);
        for (dataeng::Record& record : parsed.records) {
            record.index = records.size();
            records.push_back(std::move(record));
        }
        for (dataeng::Diagnostic& diagnostic : parsed.diagnostics) {
            if (diagnostic.record_index) {
                diagnostic.record_index = *diagnostic.record_index + record_base;
            }
            parse_diagnostics.push_back(std::move(diagnostic));
        }
    }

    if (options.parse_only) {
        dataeng::ParseResult result;
        result.records = std::move(records);
        result.diagnostics = std::move(parse_diagnostics);
        bool strict_failure = false;
        if (options.strict) {
            for (const dataeng::Diagnostic& diagnostic : result.diagnostics) {
                if (diagnostic.severity == dataeng::Severity::warning) {
                    strict_failure = true;
                }
            }
        }
        std::string output;
        if (options.json) {
            output = dataeng::to_json(result) + "\n";
        } else if (options.repairs_only || options.check) {
            for (const dataeng::Diagnostic& diagnostic : result.diagnostics) {
                output += "[" + std::string(dataeng::to_string(
                                      diagnostic.severity)) +
                          "] " + diagnostic.code + ": " + diagnostic.message +
                          "\n";
            }
        }
        if (options.output.empty()) {
            std::cout << output;
        } else {
            std::ofstream file(options.output, std::ios::binary);
            if (!file) {
                std::cerr << "warc-assemble: cannot write " << options.output
                          << '\n';
                return 1;
            }
            file << output;
        }
        return result.ok() && !strict_failure ? 0 : 2;
    }

    dataeng::Assembly assembly =
        dataeng::assemble(std::move(records), assemble_options);
    assembly.parse_diagnostics = std::move(parse_diagnostics);

    bool strict_failure = false;
    if (options.strict) {
        for (const dataeng::Diagnostic& diagnostic : assembly.parse_diagnostics) {
            if (diagnostic.severity == dataeng::Severity::warning) {
                strict_failure = true;
            }
        }
        for (const dataeng::Diagnostic& diagnostic : assembly.diagnostics) {
            if (diagnostic.severity == dataeng::Severity::warning) {
                strict_failure = true;
            }
        }
    }

    std::string output;
    if (options.json) {
        if (options.repairs_only) {
            // Compact repair-only JSON is built explicitly to keep the shape
            // stable for scripts.
            std::ostringstream repairs;
            repairs << "{\"missing_links\":[";
            for (std::size_t i = 0; i < assembly.missing_links.size(); ++i) {
                const dataeng::MissingLink& missing =
                    assembly.missing_links[i];
                if (i != 0) {
                    repairs << ',';
                }
                repairs << "{\"kind\":" << json_quote(missing.kind)
                        << ",\"record_id\":" << json_quote(missing.record_id)
                        << ",\"reference\":" << json_quote(missing.reference)
                        << ",\"reason\":" << json_quote(missing.reason) << '}';
            }
            repairs << "],\"repairs\":[";
            for (std::size_t i = 0; i < assembly.repairs.size(); ++i) {
                const dataeng::RepairAction& repair = assembly.repairs[i];
                if (i != 0) {
                    repairs << ',';
                }
                repairs << "{\"code\":" << json_quote(repair.code)
                        << ",\"record_id\":" << json_quote(repair.record_id)
                        << ",\"missing_id\":" << json_quote(repair.missing_id)
                        << ",\"action\":" << json_quote(repair.action)
                        << ",\"detail\":" << json_quote(repair.detail) << '}';
            }
            repairs << "]}";
            output = repairs.str() + "\n";
        } else {
            output = dataeng::to_json(assembly) + "\n";
        }
    } else {
        if (options.check) {
            std::ostringstream report;
            print_diagnostics(report, assembly.parse_diagnostics);
            print_diagnostics(report, assembly.diagnostics);
            output = report.str();
        } else {
            std::ostringstream report;
            print_text_report(report, assembly, options.repairs_only);
            output = report.str();
        }
    }

    if (options.output.empty()) {
        std::cout << output;
    } else {
        std::ofstream file(options.output, std::ios::binary);
        if (!file) {
            std::cerr << "warc-assemble: cannot write " << options.output
                      << '\n';
            return 1;
        }
        file << output;
    }
    return assembly.complete() && !strict_failure ? 0 : 2;
}
