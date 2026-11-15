#include "dataeng.hpp"

#include <algorithm>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

#define CHECK(condition)                                                     \
    do {                                                                     \
        ++checks;                                                            \
        if (!(condition)) {                                                  \
            ++failures;                                                      \
            std::cerr << __FILE__ << ':' << __LINE__                         \
                      << ": CHECK failed: " #condition << '\n';              \
        }                                                                    \
    } while (false)

#define CHECK_EQ(actual, expected)                                           \
    do {                                                                     \
        ++checks;                                                            \
        auto actual_value = (actual);                                        \
        auto expected_value = (expected);                                    \
        if (!(actual_value == expected_value)) {                            \
            ++failures;                                                      \
            std::cerr << __FILE__ << ':' << __LINE__                         \
                      << ": CHECK_EQ failed: " #actual " == " #expected      \
                      << " (got " << actual_value << ", want "               \
                      << expected_value << ")\n";                            \
        }                                                                    \
    } while (false)

using Headers = std::vector<std::pair<std::string, std::string>>;

std::string digest(std::string_view data, std::string_view algorithm = "sha1") {
    return std::string(algorithm) + ":" + dataeng::digest_base32(algorithm, data);
}

std::string record(Headers headers, std::string_view body) {
    std::string out = "WARC/1.1\r\n";
    for (const auto& [name, value] : headers) {
        out += name;
        out += ": ";
        out += value;
        out += "\r\n";
    }
    out += "\r\n";
    out += body;
    out += "\r\n\r\n";
    return out;
}

Headers base_headers(std::string type, std::string id, std::string date,
                     std::string target = {}) {
    Headers headers;
    headers.emplace_back("WARC-Type", std::move(type));
    headers.emplace_back("WARC-Record-ID", "<" + std::move(id) + ">");
    headers.emplace_back("WARC-Date", std::move(date));
    if (!target.empty()) {
        headers.emplace_back("WARC-Target-URI", std::move(target));
    }
    return headers;
}

void add_length(Headers& headers, std::string_view body) {
    headers.emplace_back("Content-Length", std::to_string(body.size()));
}

bool has_repair(const dataeng::Assembly& assembly, std::string_view code) {
    return std::any_of(assembly.repairs.begin(), assembly.repairs.end(),
                       [&](const dataeng::RepairAction& repair) {
                           return repair.code == code;
                       });
}

bool has_diagnostic(const dataeng::Assembly& assembly, std::string_view code) {
    auto matches = [&](const dataeng::Diagnostic& diagnostic) {
        return diagnostic.code == code;
    };
    return std::any_of(assembly.diagnostics.begin(), assembly.diagnostics.end(),
                       matches) ||
           std::any_of(assembly.parse_diagnostics.begin(),
                       assembly.parse_diagnostics.end(), matches) ||
           std::any_of(assembly.logical_records.begin(),
                       assembly.logical_records.end(),
                       [&](const dataeng::LogicalRecord& logical) {
                           return std::any_of(logical.diagnostics.begin(),
                                              logical.diagnostics.end(),
                                              matches);
                       });
}

bool has_missing(const dataeng::Assembly& assembly, std::string_view kind,
                 std::string_view reference) {
    return std::any_of(assembly.missing_links.begin(),
                       assembly.missing_links.end(),
                       [&](const dataeng::MissingLink& missing) {
                           return missing.kind == kind &&
                                  missing.reference == reference;
                       });
}

std::string response_body(std::string_view payload) {
    return "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " +
           std::to_string(payload.size()) + "\r\n\r\n" + std::string(payload);
}

std::string request_body(std::string_view target = "/") {
    return "GET " + std::string(target) + " HTTP/1.1\r\nHost: example.test\r\n\r\n";
}

std::string make_exchange(std::string request_id, std::string response_id,
                          std::string payload, std::string date = "2026-01-01T00:00:00Z") {
    std::string out;
    std::string request = request_body();
    Headers request_headers =
        base_headers("request", std::move(request_id), date, "http://example.test/");
    request_headers.emplace_back("WARC-Concurrent-To", "<" + response_id + ">");
    request_headers.emplace_back("Content-Type",
                                 "application/http; msgtype=request");
    add_length(request_headers, request);
    request_headers.emplace_back("WARC-Block-Digest", digest(request));
    out += record(std::move(request_headers), request);

    std::string response = response_body(payload);
    Headers response_headers =
        base_headers("response", std::move(response_id), date,
                     "http://example.test/");
    response_headers.emplace_back("Content-Type",
                                  "application/http; msgtype=response");
    add_length(response_headers, response);
    response_headers.emplace_back("WARC-Block-Digest", digest(response));
    response_headers.emplace_back("WARC-Payload-Digest", digest(payload));
    out += record(std::move(response_headers), response);
    return out;
}

void test_digests() {
    CHECK_EQ(dataeng::digest_hex("md5", "abc"),
             "900150983cd24fb0d6963f7d28e17f72");
    CHECK_EQ(dataeng::digest_hex("sha1", "abc"),
             "a9993e364706816aba3e25717850c26c9cd0d89d");
    CHECK_EQ(dataeng::digest_hex("sha256", "abc"),
             "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    CHECK_EQ(dataeng::digest_base32("sha1", "abc"),
             "VGMT4NSHA2AWVOR6EVYXQUGCNSONBWE5");

    dataeng::DigestValue matched;
    std::string error;
    CHECK(dataeng::verify_digest(digest("hello"), "hello", &matched, &error));
    CHECK_EQ(matched.algorithm, std::string("sha1"));
    CHECK(dataeng::verify_digest(
        "sha1:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d", "hello"));
    CHECK(dataeng::verify_digest("sha256:" +
                                     dataeng::digest_hex("sha256", "hello"),
                                 "hello"));
    CHECK(!dataeng::verify_digest(digest("hello"), "HELLO", nullptr, &error));
    CHECK(!error.empty());
}

void test_parse_and_headers() {
    std::string body = response_body("hello");
    Headers headers =
        base_headers("response", "urn:uuid:r1", "2026-01-01T00:00:00Z",
                     "http://example.test/");
    headers.emplace_back("Content-Length", std::to_string(body.size()));
    headers.emplace_back("WARC-Block-Digest", digest(body));
    std::string stream = record(headers, body);

    dataeng::ParseResult parsed = dataeng::parse_warc(stream);
    CHECK(parsed.ok());
    CHECK_EQ(parsed.records.size(), std::size_t{1});
    const dataeng::Record& parsed_record = parsed.records.front();
    CHECK_EQ(parsed_record.type(), std::string("response"));
    CHECK_EQ(parsed_record.id(), std::string("urn:uuid:r1"));
    CHECK_EQ(parsed_record.body, body);
    CHECK(parsed_record.content_length().has_value());
    CHECK_EQ(*parsed_record.content_length(), body.size());

    dataeng::Record direct;
    for (const auto& [name, value] : headers) {
        direct.fields.push_back(dataeng::Field{name, value});
    }
    CHECK_EQ(direct.header("content-length"), std::to_string(body.size()));
    CHECK_EQ(direct.headers("Content-Length").size(), std::size_t{1});
    CHECK(direct.has_header("CONTENT-LENGTH"));

    // LF-only input is tolerated by default.
    std::string lf =
        "WARC/1.1\n"
        "WARC-Type: resource\n"
        "WARC-Record-ID: <urn:uuid:lf>\n"
        "WARC-Date: 2026-01-01T00:00:00Z\n"
        "Content-Length: 5\n"
        "\n"
        "hello\n"
        "\n";
    dataeng::ParseResult lf_parsed = dataeng::parse_warc(lf);
    CHECK(lf_parsed.ok());
    CHECK_EQ(lf_parsed.records.size(), std::size_t{1});
}

void test_truncation_and_content_length() {
    std::string body = "0123456789";
    Headers headers =
        base_headers("resource", "urn:uuid:trunc", "2026-01-01T00:00:00Z");
    headers.emplace_back("Content-Length", "20");
    std::string stream = record(headers, body);
    dataeng::ParseResult parsed = dataeng::parse_warc(stream);
    CHECK(!parsed.ok());
    CHECK_EQ(parsed.records.size(), std::size_t{1});
    CHECK(parsed.records.front().truncated);
    CHECK(has_diagnostic(dataeng::assemble(stream), "content_length_mismatch"));

    Headers invalid =
        base_headers("resource", "urn:uuid:badlen", "2026-01-01T00:00:00Z");
    invalid.emplace_back("Content-Length", "not-a-number");
    dataeng::ParseResult invalid_parsed =
        dataeng::parse_warc(record(invalid, body));
    CHECK(!invalid_parsed.ok());
    CHECK(has_diagnostic(dataeng::assemble(record(invalid, body)),
                         "invalid_content_length"));
}

void test_payload_digest_scope() {
    std::string body = response_body("hello");
    Headers headers =
        base_headers("response", "urn:uuid:scope", "2026-01-01T00:00:00Z",
                     "http://example.test/");
    headers.emplace_back("Content-Type", "application/http; msgtype=response");
    add_length(headers, body);
    headers.emplace_back("WARC-Block-Digest", digest(body));
    // The block digest includes HTTP headers; it must not pass as the payload
    // digest.
    headers.emplace_back("WARC-Payload-Digest", digest(body));
    dataeng::Assembly assembly = dataeng::assemble(record(headers, body));
    CHECK(!assembly.ok());
    CHECK(has_diagnostic(assembly, "payload_digest_mismatch"));
    CHECK(has_repair(assembly, "payload_digest_mismatch"));
}

void test_complete_exchange_and_metadata() {
    std::string stream =
        make_exchange("urn:uuid:req", "urn:uuid:resp", "hello");
    std::string meta = "via: test\r\n";
    Headers meta_headers =
        base_headers("metadata", "urn:uuid:meta", "2026-01-01T00:00:02Z");
    meta_headers.emplace_back("WARC-Concurrent-To", "<urn:uuid:resp>");
    meta_headers.emplace_back("Content-Type", "application/warc-fields");
    add_length(meta_headers, meta);
    meta_headers.emplace_back("WARC-Block-Digest", digest(meta));
    stream += record(std::move(meta_headers), meta);

    dataeng::Assembly assembly = dataeng::assemble(stream);
    CHECK(assembly.ok());
    CHECK(assembly.complete());
    CHECK_EQ(assembly.logical_records.size(), std::size_t{3});
    CHECK_EQ(assembly.exchanges.size(), std::size_t{1});
    const dataeng::Exchange& exchange = assembly.exchanges.front();
    CHECK(exchange.complete);
    CHECK(exchange.response.has_value());
    CHECK_EQ(exchange.requests.size(), std::size_t{1});
    CHECK_EQ(exchange.metadata.size(), std::size_t{1});
    CHECK(assembly.repairs.empty());
    CHECK(assembly.missing_links.empty());

    // IDs are matched through angle brackets and urn:uuid case differences.
    std::string normalized =
        make_exchange("urn:uuid:REQ", "urn:uuid:RESP", "hello");
    dataeng::Assembly normalized_assembly = dataeng::assemble(normalized);
    CHECK(normalized_assembly.complete());
}

void test_dangling_request_has_no_fabricated_exchange() {
    std::string request = request_body("/missing");
    Headers headers = base_headers("request", "urn:uuid:req", "2026-01-01T00:00:00Z",
                                   "http://example.test/missing");
    headers.emplace_back("WARC-Concurrent-To", "<urn:uuid:missing-response>");
    headers.emplace_back("Content-Type", "application/http; msgtype=request");
    add_length(headers, request);
    headers.emplace_back("WARC-Block-Digest", digest(request));
    dataeng::Assembly assembly = dataeng::assemble(record(headers, request));

    CHECK(!assembly.ok());
    CHECK(!assembly.complete());
    CHECK(assembly.exchanges.empty());
    CHECK_EQ(assembly.unpaired_requests.size(), std::size_t{1});
    CHECK(has_missing(assembly, "response", "urn:uuid:missing-response"));
    CHECK(has_repair(assembly, "missing_concurrent_record"));
    CHECK_EQ(assembly.exchanges.size(), std::size_t{0});
}

void test_response_without_request_is_incomplete() {
    std::string body = response_body("hello");
    Headers headers =
        base_headers("response", "urn:uuid:resp", "2026-01-01T00:00:00Z",
                     "http://example.test/");
    headers.emplace_back("Content-Type", "application/http; msgtype=response");
    add_length(headers, body);
    headers.emplace_back("WARC-Block-Digest", digest(body));
    dataeng::Assembly assembly = dataeng::assemble(record(headers, body));

    CHECK(!assembly.ok());
    CHECK(has_diagnostic(assembly, "missing_request"));
    CHECK(!assembly.complete());
    CHECK_EQ(assembly.exchanges.size(), std::size_t{1});
    CHECK(!assembly.exchanges.front().complete);
    CHECK(assembly.exchanges.front().requests.empty());
    CHECK(has_missing(assembly, "request", ""));
    CHECK(has_repair(assembly, "missing_request"));
    CHECK_EQ(assembly.logical_records.size(), std::size_t{1});
    CHECK(assembly.logical_records.front().complete);
}

std::string make_segmented_response(bool include_total, std::uint64_t total,
                                    bool bad_digest = false) {
    std::string part1 =
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhel";
    std::string part2 = "lo";
    std::string request = request_body("/seg");

    Headers request_headers = base_headers("request", "urn:uuid:seg-req",
                                          "2026-02-01T00:00:00Z",
                                          "http://example.test/seg");
    request_headers.emplace_back("WARC-Concurrent-To", "<urn:uuid:seg-resp>");
    request_headers.emplace_back("Content-Type",
                                 "application/http; msgtype=request");
    add_length(request_headers, request);
    request_headers.emplace_back("WARC-Block-Digest", digest(request));
    std::string out = record(std::move(request_headers), request);

    Headers head = base_headers("response", "urn:uuid:seg-resp",
                                "2026-02-01T00:00:00Z",
                                "http://example.test/seg");
    head.emplace_back("Content-Type", "application/http; msgtype=response");
    head.emplace_back("WARC-Segment-Number", "1");
    add_length(head, part1);
    head.emplace_back("WARC-Block-Digest",
                      bad_digest ? digest("wrong") : digest(part1));
    head.emplace_back("WARC-Payload-Digest", digest("hello"));
    out += record(std::move(head), part1);

    Headers continuation = base_headers("continuation", "urn:uuid:seg-cont",
                                        "2026-02-01T00:00:01Z",
                                        "http://example.test/seg");
    continuation.emplace_back("WARC-Segment-Origin-ID", "<urn:uuid:seg-resp>");
    continuation.emplace_back("WARC-Segment-Number", "2");
    if (include_total) {
        continuation.emplace_back("WARC-Segment-Total-Length",
                                  std::to_string(total));
    }
    add_length(continuation, part2);
    continuation.emplace_back("WARC-Block-Digest", digest(part2));
    out += record(std::move(continuation), part2);
    return out;
}

void test_segmented_body() {
    std::string part1 =
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhel";
    std::string part2 = "lo";
    dataeng::Assembly assembly =
        dataeng::assemble(make_segmented_response(true, part1.size() + part2.size()));
    CHECK(assembly.ok());
    CHECK(assembly.complete());
    const dataeng::LogicalRecord& response = assembly.logical_records[1];
    CHECK(response.segmented);
    CHECK(response.complete);
    CHECK_EQ(response.total_length, part1.size() + part2.size());
    CHECK_EQ(response.payload, std::string("hello"));
    CHECK_EQ(response.segments.size(), std::size_t{2});
    CHECK_EQ(response.segments[0].number, std::uint64_t{1});
    CHECK_EQ(response.segments[1].number, std::uint64_t{2});

    dataeng::Assembly missing_total =
        dataeng::assemble(make_segmented_response(false, 0));
    CHECK(!missing_total.ok());
    CHECK(has_diagnostic(missing_total, "segment_total_length_missing"));
    CHECK(has_repair(missing_total, "segment_total_length_missing"));
    CHECK(!missing_total.logical_records[1].complete);

    dataeng::Assembly wrong_total = dataeng::assemble(
        make_segmented_response(true, part1.size() + part2.size() - 1));
    CHECK(!wrong_total.ok());
    CHECK(has_diagnostic(wrong_total, "segment_total_length_mismatch"));
    CHECK(has_repair(wrong_total, "segment_total_length_mismatch"));

    dataeng::Assembly wrong_digest = dataeng::assemble(
        make_segmented_response(true, part1.size() + part2.size(), true));
    CHECK(!wrong_digest.ok());
    CHECK(has_diagnostic(wrong_digest, "block_digest_mismatch"));
    CHECK(has_repair(wrong_digest, "block_digest_mismatch"));
}

void test_segment_order_and_missing_segment() {
    std::string part1 =
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhel";
    std::string part2 = "lo";
    std::string full = make_segmented_response(true, part1.size() + part2.size());
    std::size_t first = full.find("WARC/1.1\r\nWARC-Type: response");
    std::size_t second = full.find("WARC/1.1\r\nWARC-Type: continuation");
    CHECK(first != std::string::npos);
    CHECK(second != std::string::npos);
    std::string request = full.substr(0, first);
    std::string head = full.substr(first, second - first);
    std::string continuation = full.substr(second);
    std::string reordered = request + continuation + head;

    dataeng::Assembly ordered = dataeng::assemble(reordered);
    CHECK(ordered.ok());
    CHECK(ordered.complete());
    const dataeng::LogicalRecord& response = ordered.logical_records[1];
    CHECK_EQ(response.segments.size(), std::size_t{2});
    CHECK_EQ(response.segments[0].number, std::uint64_t{1});
    CHECK_EQ(response.segments[1].number, std::uint64_t{2});
    CHECK_EQ(response.payload, std::string("hello"));
    CHECK(has_diagnostic(ordered, "segments_out_of_order"));

    // Change continuation segment 2 to segment 3.  Segment 2 is missing and
    // the assembler must not silently close the gap.
    std::string gap = full;
    std::size_t number = gap.find("WARC-Segment-Number: 2");
    CHECK(number != std::string::npos);
    gap.replace(number, std::string("WARC-Segment-Number: 2").size(),
                "WARC-Segment-Number: 3");
    dataeng::Assembly gap_assembly = dataeng::assemble(gap);
    CHECK(!gap_assembly.ok());
    CHECK(has_diagnostic(gap_assembly, "missing_segment"));
    CHECK(has_missing(gap_assembly, "segment", "2"));
    CHECK(has_repair(gap_assembly, "missing_segment"));
    CHECK(!gap_assembly.logical_records[1].complete);

    // Compatibility: accept a continuation whose only origin signal is
    // WARC-Concurrent-To, but report that the standard field is missing.
    std::string fallback = full;
    std::size_t origin_header =
        fallback.find("WARC-Segment-Origin-ID: <urn:uuid:seg-resp>\r\n");
    CHECK(origin_header != std::string::npos);
    fallback.erase(origin_header,
                   std::string("WARC-Segment-Origin-ID: <urn:uuid:seg-resp>\r\n")
                       .size());
    std::size_t continuation_number =
        fallback.find("WARC-Segment-Number: 2");
    CHECK(continuation_number != std::string::npos);
    fallback.insert(continuation_number,
                    "WARC-Concurrent-To: <urn:uuid:seg-resp>\r\n");
    dataeng::Assembly fallback_assembly = dataeng::assemble(fallback);
    CHECK(fallback_assembly.ok());
    CHECK(fallback_assembly.complete());
    CHECK_EQ(fallback_assembly.logical_records[1].segments.size(),
             std::size_t{2});
    CHECK_EQ(fallback_assembly.logical_records[1].payload,
             std::string("hello"));
    CHECK(has_diagnostic(fallback_assembly,
                         "continuation_origin_from_concurrent_to"));
}

void test_orphan_continuation() {
    std::string body = "lo";
    Headers headers =
        base_headers("continuation", "urn:uuid:orphan", "2026-01-01T00:00:00Z");
    headers.emplace_back("WARC-Segment-Origin-ID", "<urn:uuid:no-such-head>");
    headers.emplace_back("WARC-Segment-Number", "2");
    headers.emplace_back("WARC-Segment-Total-Length", "100");
    add_length(headers, body);
    headers.emplace_back("WARC-Block-Digest", digest(body));
    dataeng::Assembly assembly =
        dataeng::assemble(record(headers, body));
    CHECK(!assembly.ok());
    CHECK(!assembly.complete());
    CHECK_EQ(assembly.logical_records.size(), std::size_t{1});
    CHECK(!assembly.logical_records.front().has_head);
    CHECK(!assembly.logical_records.front().complete);
    CHECK(has_missing(assembly, "segment_origin", "urn:uuid:no-such-head"));
    CHECK(has_repair(assembly, "orphan_continuation"));
}

std::string make_revisit(std::string overall, bool unknown_target,
                         bool bad_revisit_digest, bool target_is_request,
                         bool omit_refers_to, bool omit_uri_ref = false) {
    std::string original_payload = "hello";
    std::string original_response = response_body(original_payload);
    std::string original_request = request_body("/r");

    Headers original_request_headers =
        base_headers("request", "urn:uuid:orig-req",
                     "2026-03-01T00:00:00Z", "http://example.test/r");
    original_request_headers.emplace_back("WARC-Concurrent-To",
                                          "<urn:uuid:orig-resp>");
    original_request_headers.emplace_back(
        "Content-Type", "application/http; msgtype=request");
    add_length(original_request_headers, original_request);
    original_request_headers.emplace_back("WARC-Block-Digest",
                                          digest(original_request));
    overall += record(std::move(original_request_headers), original_request);

    Headers original_headers =
        base_headers("response", "urn:uuid:orig-resp",
                     "2026-03-01T00:00:01Z", "http://example.test/r");
    original_headers.emplace_back("Content-Type",
                                  "application/http; msgtype=response");
    add_length(original_headers, original_response);
    original_headers.emplace_back("WARC-Block-Digest",
                                  digest(original_response));
    original_headers.emplace_back("WARC-Payload-Digest",
                                  digest(original_payload));
    overall += record(std::move(original_headers), original_response);

    std::string revisit_request = request_body("/r");
    Headers revisit_request_headers =
        base_headers("request", "urn:uuid:rev-req",
                     "2026-03-02T00:00:00Z", "http://example.test/r");
    revisit_request_headers.emplace_back("WARC-Concurrent-To",
                                         "<urn:uuid:revisit>");
    revisit_request_headers.emplace_back(
        "Content-Type", "application/http; msgtype=request");
    add_length(revisit_request_headers, revisit_request);
    revisit_request_headers.emplace_back("WARC-Block-Digest",
                                         digest(revisit_request));
    overall += record(std::move(revisit_request_headers), revisit_request);

    std::string revisit_headers_body =
        "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\n\r\n";
    Headers revisit_headers =
        base_headers("revisit", "urn:uuid:revisit",
                     "2026-03-02T00:00:01Z", "http://example.test/r");
    revisit_headers.emplace_back(
        "WARC-Profile",
        "http://netpreserve.org/warc/1.1/revisit/identical-payload-digest");
    if (!omit_refers_to) {
        std::string target =
            target_is_request ? "urn:uuid:orig-req" : "urn:uuid:orig-resp";
        if (unknown_target) {
            target = "urn:uuid:not-present";
        }
        revisit_headers.emplace_back("WARC-Refers-To", "<" + target + ">");
    }
    if (!omit_uri_ref) {
        revisit_headers.emplace_back("WARC-Refers-To-Target-URI",
                                     "http://example.test/r");
        revisit_headers.emplace_back("WARC-Refers-To-Date",
                                     "2026-03-01T00:00:01Z");
    }
    revisit_headers.emplace_back(
        "WARC-Payload-Digest",
        bad_revisit_digest ? digest("other") : digest(original_payload));
    revisit_headers.emplace_back("Content-Type",
                                 "application/http; msgtype=response");
    add_length(revisit_headers, revisit_headers_body);
    revisit_headers.emplace_back("WARC-Block-Digest",
                                 digest(revisit_headers_body));
    overall += record(std::move(revisit_headers), revisit_headers_body);
    return overall;
}

void test_revisit_resolution() {
    dataeng::Assembly good = dataeng::assemble(make_revisit(
        {}, false, false, false, false));
    CHECK(good.ok());
    CHECK(good.complete());
    CHECK_EQ(good.logical_records.size(), std::size_t{4});
    const dataeng::LogicalRecord& revisit = good.logical_records[3];
    CHECK(revisit.type == "revisit");
    CHECK(revisit.complete);
    CHECK(revisit.revisit_target.has_value());
    CHECK_EQ(*revisit.revisit_target, std::size_t{1});
    CHECK_EQ(revisit.payload, std::string());
    CHECK_EQ(good.logical_records[*revisit.revisit_target].payload,
             std::string("hello"));

    dataeng::Assembly unknown = dataeng::assemble(make_revisit(
        {}, true, false, false, false));
    CHECK(!unknown.ok());
    CHECK(!unknown.complete());
    CHECK(!unknown.logical_records[3].complete);
    CHECK(!unknown.logical_records[3].revisit_target.has_value());
    CHECK(has_missing(unknown, "payload", "urn:uuid:not-present"));
    CHECK(has_repair(unknown, "revisit_target_missing"));

    dataeng::Assembly bad_digest = dataeng::assemble(make_revisit(
        {}, false, true, false, false));
    CHECK(!bad_digest.ok());
    CHECK(bad_digest.logical_records[3].revisit_target.has_value());
    CHECK(has_diagnostic(bad_digest, "revisit_digest_mismatch"));
    CHECK(has_repair(bad_digest, "revisit_digest_mismatch"));

    dataeng::Assembly not_payload = dataeng::assemble(make_revisit(
        {}, false, false, true, false));
    CHECK(!not_payload.ok());
    CHECK(!not_payload.logical_records[3].revisit_target.has_value());
    CHECK(has_diagnostic(not_payload, "revisit_target_not_payload"));
    CHECK(has_repair(not_payload, "revisit_target_not_payload"));

    // With no WARC-Refers-To, a unique payload digest is enough to identify
    // the known payload.
    dataeng::Assembly by_digest = dataeng::assemble(make_revisit(
        {}, false, false, false, true, true));
    CHECK(by_digest.ok());
    CHECK(by_digest.complete());
    CHECK(by_digest.logical_records[3].revisit_target.has_value());
    CHECK_EQ(*by_digest.logical_records[3].revisit_target, std::size_t{1});
}

void test_duplicate_ids_and_json() {
    std::string request = request_body();
    Headers first = base_headers("request", "urn:uuid:duplicate",
                                 "2026-01-01T00:00:00Z");
    add_length(first, request);
    Headers second = base_headers("request", "urn:uuid:duplicate",
                                  "2026-01-01T00:00:01Z");
    add_length(second, request);
    dataeng::Assembly assembly =
        dataeng::assemble(record(first, request) + record(second, request));
    CHECK(!assembly.ok());
    CHECK(has_diagnostic(assembly, "duplicate_record_id"));
    CHECK(has_repair(assembly, "duplicate_record_id"));

    std::string json = dataeng::to_json(assembly);
    CHECK(json.find("\"duplicate_record_id\"") != std::string::npos);
    CHECK(json.find("\"repairs\"") != std::string::npos);
    CHECK(json.find("\"missing_links\"") != std::string::npos);

    dataeng::ParseResult parsed = dataeng::parse_warc(make_exchange(
        "urn:uuid:req", "urn:uuid:resp", "hello"));
    std::string parse_json = dataeng::to_json(parsed);
    CHECK(parse_json.find("\"records\"") != std::string::npos);
    CHECK(parse_json.find("\"ok\":true") != std::string::npos);
}

}  // namespace

int main() {
    test_digests();
    test_parse_and_headers();
    test_truncation_and_content_length();
    test_payload_digest_scope();
    test_complete_exchange_and_metadata();
    test_dangling_request_has_no_fabricated_exchange();
    test_response_without_request_is_incomplete();
    test_segmented_body();
    test_segment_order_and_missing_segment();
    test_orphan_continuation();
    test_revisit_resolution();
    test_duplicate_ids_and_json();

    if (failures != 0) {
        std::cerr << failures << " of " << checks << " checks failed\n";
        return 1;
    }
    std::cout << checks << " checks passed\n";
    return 0;
}
