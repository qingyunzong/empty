#include "dataeng.hpp"

#include <cstdio>
#include <string>

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    ++g_checks;                                                  \
    if (!(cond)) {                                               \
      ++g_failures;                                              \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__,         \
                   __LINE__, #cond);                             \
    }                                                            \
  } while (0)

using namespace dataeng;

Reply make_reply(int code, std::string text) {
  return Reply{code, {std::move(text)}};
}

void test_single_line_reply() {
  ReplyParser parser;
  parser.feed("220 Service ready\r\n");
  CHECK(parser.has_reply());
  Reply reply = parser.take_reply();
  CHECK(reply.code == 220);
  CHECK(!reply.multiline());
  CHECK(reply.lines.size() == 1 && reply.lines[0] == "Service ready");
  CHECK(!parser.has_reply());
}

void test_multiline_reply() {
  ReplyParser parser;
  parser.feed("230-Login successful.\r\n");
  CHECK(!parser.has_reply());
  parser.feed("230-Welcome banner line\r\n");
  parser.feed("unprefixed continuation\r\n");
  CHECK(!parser.has_reply());
  parser.feed("230 Logged in\r\n");
  CHECK(parser.has_reply());
  Reply reply = parser.take_reply();
  CHECK(reply.code == 230);
  CHECK(reply.multiline());
  CHECK(reply.lines.size() == 4);
  CHECK(reply.lines[0] == "Login successful.");
  CHECK(reply.lines[2] == "unprefixed continuation");
  CHECK(reply.lines[3] == "Logged in");
}

void test_fragmented_feed() {
  ReplyParser parser;
  const std::string wire = "227 Entering Passive Mode (192,168,1,10,19,136).\r\n";
  for (char c : wire) parser.feed(std::string_view(&c, 1));
  CHECK(parser.has_reply());
  Reply reply = parser.take_reply();
  CHECK(reply.code == 227);
}

void test_pasv_parse() {
  const auto endpoint =
      parse_pasv_reply(make_reply(227, "Entering Passive Mode (10,0,0,8,193,225)"));
  CHECK(endpoint.has_value());
  CHECK(endpoint->host == "10.0.0.8");
  CHECK(endpoint->port == 193 * 256 + 225);
  CHECK(!parse_pasv_reply(make_reply(226, "done")).has_value());
  CHECK(!parse_pasv_reply(make_reply(227, "no tuple here")).has_value());
}

void test_epsv_parse() {
  const auto port = parse_epsv_reply(make_reply(229, "Entering Extended Passive Mode (|||6446|)"));
  CHECK(port.has_value());
  CHECK(*port == 6446);
  CHECK(!parse_epsv_reply(make_reply(229, "(|tcp||6446|)")).has_value());
  CHECK(!parse_epsv_reply(make_reply(500, "oops")).has_value());
}

void test_private_ipv4() {
  CHECK(is_private_ipv4("10.1.2.3"));
  CHECK(is_private_ipv4("172.16.0.1"));
  CHECK(is_private_ipv4("172.31.255.255"));
  CHECK(is_private_ipv4("192.168.0.1"));
  CHECK(is_private_ipv4("127.0.0.1"));
  CHECK(is_private_ipv4("169.254.1.1"));
  CHECK(is_private_ipv4("0.0.0.0"));
  CHECK(!is_private_ipv4("172.15.0.1"));
  CHECK(!is_private_ipv4("172.32.0.1"));
  CHECK(!is_private_ipv4("203.0.113.7"));
  CHECK(!is_private_ipv4("ftp.example.com"));
}

void test_private_pasv_rewritten_to_control_host() {
  const Endpoint control_peer{"203.0.113.7", 21};
  const Endpoint advertised{"192.168.4.9", 5000};
  const auto resolved = resolve_data_endpoint(
      advertised, control_peer, PasvAddressPolicy::kRewritePrivateToControlHost);
  CHECK(resolved.has_value());
  CHECK(resolved->host == "203.0.113.7");  // control peer host, port kept
  CHECK(resolved->port == 5000);
}

void test_public_pasv_never_crosses_hosts() {
  const Endpoint control_peer{"203.0.113.7", 21};
  const Endpoint advertised{"198.51.100.22", 5000};  // different public host
  const auto resolved = resolve_data_endpoint(
      advertised, control_peer, PasvAddressPolicy::kRewritePrivateToControlHost);
  CHECK(resolved.has_value());
  CHECK(*resolved == advertised);  // verbatim, never rewritten to another host
}

void test_reject_private_policy() {
  const Endpoint control_peer{"203.0.113.7", 21};
  const Endpoint advertised{"10.1.1.1", 5000};
  CHECK(!resolve_data_endpoint(advertised, control_peer,
                               PasvAddressPolicy::kRejectPrivate)
             .has_value());
  const auto accepted = resolve_data_endpoint(
      advertised, control_peer, PasvAddressPolicy::kAcceptAsIs);
  CHECK(accepted.has_value() && *accepted == advertised);
}

void test_session_epsv_uses_control_host() {
  Session session({"203.0.113.7", 21}, {"tls-session-1"});
  const auto endpoint = session.data_endpoint_for_epsv(
      make_reply(229, "Entering Extended Passive Mode (|||6446|)"));
  CHECK(endpoint.has_value());
  CHECK(endpoint->host == "203.0.113.7");
  CHECK(endpoint->port == 6446);
}

void test_tls_binding_mismatch_fails() {
  Session session({"203.0.113.7", 21}, {"tls-session-1"});
  auto txn = session.begin_transfer("file-a");
  CHECK(txn.bind_data_channel({"tls-session-1"}));
  CHECK(!txn.finished());

  auto bad = session.begin_transfer("file-b");
  CHECK(!bad.bind_data_channel({"other-session"}));
  CHECK(bad.state() == TerminalState::kFailed);
}

void test_completion_is_terminal() {
  TransferTransaction txn("file", {"s"});
  int notifications = 0;
  txn.set_terminal_handler([&](TerminalState) { ++notifications; });
  txn.on_data_bytes(1024);
  txn.on_reply(make_reply(226, "Transfer complete"));
  CHECK(txn.state() == TerminalState::kCompleted);
  CHECK(txn.bytes_received() == 1024);
  txn.abort();        // late ABOR must not flip the outcome
  txn.on_timeout();   // nor a late timeout
  CHECK(txn.state() == TerminalState::kCompleted);
  CHECK(notifications == 1);
}

void test_abor_beats_late_226() {
  TransferTransaction txn("file", {"s"});
  int notifications = 0;
  txn.set_terminal_handler([&](TerminalState) { ++notifications; });
  txn.abort();
  CHECK(txn.state() == TerminalState::kAborted);
  CHECK(txn.draining());
  txn.on_reply(make_reply(426, "Transfer aborted"));  // drained
  txn.on_reply(make_reply(226, "Transfer complete"));  // late 226, drained
  CHECK(txn.state() == TerminalState::kAborted);
  CHECK(notifications == 1);
}

void test_timeout_beats_late_226() {
  TransferTransaction txn("file", {"s"});
  int notifications = 0;
  txn.set_terminal_handler([&](TerminalState) { ++notifications; });
  txn.on_timeout();
  CHECK(txn.state() == TerminalState::kTimedOut);
  txn.on_reply(make_reply(226, "Transfer complete"));  // late 226, drained
  CHECK(txn.state() == TerminalState::kTimedOut);
  CHECK(notifications == 1);
}

void test_error_reply_fails_transaction() {
  TransferTransaction txn("file", {"s"});
  txn.on_reply(make_reply(550, "File unavailable"));
  CHECK(txn.state() == TerminalState::kFailed);
}

}  // namespace

int main() {
  test_single_line_reply();
  test_multiline_reply();
  test_fragmented_feed();
  test_pasv_parse();
  test_epsv_parse();
  test_private_ipv4();
  test_private_pasv_rewritten_to_control_host();
  test_public_pasv_never_crosses_hosts();
  test_reject_private_policy();
  test_session_epsv_uses_control_host();
  test_tls_binding_mismatch_fails();
  test_completion_is_terminal();
  test_abor_beats_late_226();
  test_timeout_beats_late_226();
  test_error_reply_fails_transaction();

  std::fprintf(stderr, "%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
