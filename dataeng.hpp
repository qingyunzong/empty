#pragma once

#include <cstdint>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// Embeddable FTPS session component for the legacy collection agent.
//
// Binds control replies (incl. multi-line), EPSV/PASV data-channel
// negotiation and the TLS session to a single transfer transaction.
namespace dataeng {

struct Endpoint {
  std::string host;
  std::uint16_t port = 0;
  bool operator==(const Endpoint&) const = default;
};

// True for RFC1918 / loopback / link-local / unspecified IPv4 literals.
bool is_private_ipv4(std::string_view host);

// ---- Control channel replies (RFC 959, incl. multi-line) ----

struct Reply {
  int code = 0;
  std::vector<std::string> lines;  // text with the "nnn[ -]" prefix stripped
  bool multiline() const { return lines.size() > 1; }
};

// Incremental parser: feed raw control-channel bytes, take complete replies.
class ReplyParser {
 public:
  void feed(std::string_view bytes);
  bool has_reply() const { return !ready_.empty(); }
  Reply take_reply();

 private:
  void drain_lines();

  std::string buffer_;
  std::optional<Reply> open_;  // reply currently being assembled
  std::deque<Reply> ready_;
};

// ---- EPSV / PASV reply parsing ----

// 227 "(h1,h2,h3,h4,p1,p2)"; host/port the server advertises.
std::optional<Endpoint> parse_pasv_reply(const Reply& reply);
// 229 "(|||port|)"; EPSV carries no address, host comes from the control peer.
std::optional<std::uint16_t> parse_epsv_reply(const Reply& reply);

// ---- Private-address rewrite policy ----

enum class PasvAddressPolicy {
  kRewritePrivateToControlHost,  // private addr -> control peer host
  kRejectPrivate,                // fail the transfer instead of rewriting
  kAcceptAsIs,                   // legacy behaviour, use verbatim
};

// Resolves the advertised PASV endpoint against policy. Rewriting never
// crosses hosts: the only substitution ever made is the control peer's own
// host, and only when the advertised address is private. Public addresses
// are used verbatim (std::nullopt only when policy rejects).
std::optional<Endpoint> resolve_data_endpoint(const Endpoint& advertised,
                                              const Endpoint& control_peer,
                                              PasvAddressPolicy policy);

// ---- TLS session binding ----

struct TlsSessionId {
  std::string value;
  bool operator==(const TlsSessionId&) const = default;
};

// ---- Transfer transaction: exactly one terminal state per file ----

enum class TerminalState {
  kNone,
  kCompleted,  // 226 observed before any abort/timeout
  kAborted,    // ABOR won the race
  kTimedOut,   // transfer timeout won the race
  kFailed,     // protocol error or TLS session mismatch
};

const char* to_string(TerminalState state);

// One instance per file transfer. Whichever event lands first (226, ABOR,
// timeout, failure) fixes the terminal state; late events are drained and
// never produce a second outcome.
class TransferTransaction {
 public:
  using TerminalHandler = std::function<void(TerminalState)>;

  TransferTransaction(std::string file_token, TlsSessionId control_session);

  // Data channel must prove it resumed the control connection's TLS
  // session; a mismatch fails the transaction.
  bool bind_data_channel(const TlsSessionId& data_session);

  void on_data_bytes(std::size_t n);
  void on_reply(const Reply& reply);  // 226/426/4xx/5xx on the control channel
  void abort();                       // ABOR issued on the control channel
  void on_timeout();

  void set_terminal_handler(TerminalHandler handler);

  TerminalState state() const { return state_; }
  bool finished() const { return state_ != TerminalState::kNone; }
  // True after ABOR while late 226/426 replies are still being drained.
  bool draining() const { return draining_; }
  std::size_t bytes_received() const { return bytes_; }
  const std::string& file_token() const { return file_token_; }

 private:
  void finalize(TerminalState state);

  std::string file_token_;
  TlsSessionId control_session_;
  TerminalState state_ = TerminalState::kNone;
  bool data_bound_ = false;
  bool draining_ = false;
  std::size_t bytes_ = 0;
  TerminalHandler terminal_handler_;
};

// ---- Session facade wiring the pieces together ----

// Owns the control-channel parser and the control connection's identity;
// every transfer transaction derives its TLS binding from here.
class Session {
 public:
  Session(Endpoint control_peer, TlsSessionId control_session,
          PasvAddressPolicy pasv_policy = PasvAddressPolicy::kRewritePrivateToControlHost);

  ReplyParser& control_parser() { return parser_; }
  const Endpoint& control_peer() const { return control_peer_; }
  const TlsSessionId& control_session() const { return control_session_; }

  // Resolve a PASV reply to the endpoint the data channel should dial.
  std::optional<Endpoint> data_endpoint_for(const Reply& pasv_reply) const;
  // Resolve an EPSV reply: port from the reply, host always the control peer.
  std::optional<Endpoint> data_endpoint_for_epsv(const Reply& epsv_reply) const;

  TransferTransaction begin_transfer(std::string file_token) const;

 private:
  Endpoint control_peer_;
  TlsSessionId control_session_;
  PasvAddressPolicy pasv_policy_;
  ReplyParser parser_;
};

}  // namespace dataeng
