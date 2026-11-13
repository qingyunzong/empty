#include "dataeng.hpp"

#include <array>
#include <charconv>
#include <cctype>

namespace dataeng {
namespace {

bool parse_octet(std::string_view text, unsigned& out) {
  if (text.empty() || text.size() > 3) return false;
  unsigned value = 0;
  for (char c : text) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    value = value * 10 + static_cast<unsigned>(c - '0');
  }
  if (value > 255) return false;
  out = value;
  return true;
}

bool parse_ipv4(std::string_view host, std::array<unsigned, 4>& octets) {
  std::size_t start = 0;
  for (int i = 0; i < 4; ++i) {
    const std::size_t dot = host.find('.', start);
    const bool last = (i == 3);
    if (last != (dot == std::string_view::npos)) return false;
    if (!parse_octet(host.substr(start, last ? std::string_view::npos
                                             : dot - start),
                     octets[i]))
      return false;
    start = dot + 1;
  }
  return true;
}

bool parse_code_prefix(std::string_view line, int& code, char& separator) {
  if (line.size() < 4) return false;
  if (!std::isdigit(static_cast<unsigned char>(line[0])) ||
      !std::isdigit(static_cast<unsigned char>(line[1])) ||
      !std::isdigit(static_cast<unsigned char>(line[2])))
    return false;
  code = (line[0] - '0') * 100 + (line[1] - '0') * 10 + (line[2] - '0');
  separator = line[3];
  return true;
}

std::string_view strip_prefix(std::string_view line) {
  if (line.size() >= 4 &&
      (line[3] == ' ' || line[3] == '-') &&
      std::isdigit(static_cast<unsigned char>(line[0])))
    return line.substr(4);
  return line;
}

}  // namespace

bool is_private_ipv4(std::string_view host) {
  std::array<unsigned, 4> ip{};
  if (!parse_ipv4(host, ip)) return false;
  if (ip[0] == 0 || ip[0] == 10 || ip[0] == 127) return true;
  if (ip[0] == 169 && ip[1] == 254) return true;
  if (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) return true;
  if (ip[0] == 192 && ip[1] == 168) return true;
  return false;
}

// ---- ReplyParser ----

void ReplyParser::feed(std::string_view bytes) {
  buffer_.append(bytes);
  drain_lines();
}

Reply ReplyParser::take_reply() {
  Reply reply = std::move(ready_.front());
  ready_.pop_front();
  return reply;
}

void ReplyParser::drain_lines() {
  std::size_t pos;
  while ((pos = buffer_.find('\n')) != std::string::npos) {
    std::string_view line(buffer_.data(), pos);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);

    int code = 0;
    char sep = 0;
    const bool prefixed = parse_code_prefix(line, code, sep);

    if (!open_) {
      if (prefixed && sep == '-') {
        open_ = Reply{code, {std::string(strip_prefix(line))}};
      } else if (prefixed && sep == ' ') {
        ready_.push_back(Reply{code, {std::string(strip_prefix(line))}});
      }
      // Unprefixed lines outside a multi-line reply are ignored.
    } else if (prefixed && sep == ' ' && code == open_->code) {
      open_->lines.emplace_back(strip_prefix(line));
      ready_.push_back(std::move(*open_));
      open_.reset();
    } else {
      open_->lines.emplace_back(strip_prefix(line));
    }
    buffer_.erase(0, pos + 1);
  }
}

// ---- PASV / EPSV parsing ----

std::optional<Endpoint> parse_pasv_reply(const Reply& reply) {
  if (reply.code != 227 || reply.lines.empty()) return std::nullopt;
  const std::string& text = reply.lines.back();
  const std::size_t open = text.find('(');
  const std::size_t close = text.find(')', open == std::string::npos ? 0 : open);
  if (open == std::string::npos || close == std::string::npos) return std::nullopt;

  std::string_view body(text.data() + open + 1, close - open - 1);
  std::array<unsigned, 6> fields{};
  std::size_t start = 0;
  for (int i = 0; i < 6; ++i) {
    const std::size_t comma = body.find(',', start);
    const bool last = (i == 5);
    if (last != (comma == std::string_view::npos)) return std::nullopt;
    const std::string_view field =
        body.substr(start, last ? std::string_view::npos : comma - start);
    unsigned value = 0;
    const auto* end = field.data() + field.size();
    if (std::from_chars(field.data(), end, value).ec != std::errc{} ||
        value > 255)
      return std::nullopt;
    fields[i] = value;
    start = comma + 1;
  }

  Endpoint endpoint;
  endpoint.host = std::to_string(fields[0]) + '.' + std::to_string(fields[1]) +
                  '.' + std::to_string(fields[2]) + '.' +
                  std::to_string(fields[3]);
  endpoint.port = static_cast<std::uint16_t>(fields[4] * 256 + fields[5]);
  return endpoint;
}

std::optional<std::uint16_t> parse_epsv_reply(const Reply& reply) {
  if (reply.code != 229 || reply.lines.empty()) return std::nullopt;
  const std::string& text = reply.lines.back();
  const std::size_t open = text.find('(');
  const std::size_t close = text.find(')', open == std::string::npos ? 0 : open);
  if (open == std::string::npos || close == std::string::npos ||
      close - open < 2)
    return std::nullopt;

  // Format: (d f1 d f2 d f3 d port d) with empty f1..f3, e.g. (|||6446|).
  std::string_view body(text.data() + open + 1, close - open - 1);
  const char delim = body.front();
  std::array<std::string_view, 5> fields;
  std::size_t start = 0;
  for (int i = 0; i < 4; ++i) {
    const std::size_t sep = body.find(delim, start);
    if (sep == std::string_view::npos) return std::nullopt;
    fields[i] = body.substr(start, sep - start);
    start = sep + 1;
  }
  fields[4] = body.substr(start);
  if (!fields[0].empty() || !fields[1].empty() || !fields[2].empty() ||
      !fields[4].empty())
    return std::nullopt;

  unsigned port = 0;
  const auto* end = fields[3].data() + fields[3].size();
  if (std::from_chars(fields[3].data(), end, port).ec != std::errc{} ||
      port == 0 || port > 65535)
    return std::nullopt;
  return static_cast<std::uint16_t>(port);
}

// ---- Private-address policy ----

std::optional<Endpoint> resolve_data_endpoint(const Endpoint& advertised,
                                              const Endpoint& control_peer,
                                              PasvAddressPolicy policy) {
  if (!is_private_ipv4(advertised.host)) return advertised;  // never cross hosts
  switch (policy) {
    case PasvAddressPolicy::kRewritePrivateToControlHost:
      return Endpoint{control_peer.host, advertised.port};
    case PasvAddressPolicy::kRejectPrivate:
      return std::nullopt;
    case PasvAddressPolicy::kAcceptAsIs:
      return advertised;
  }
  return std::nullopt;
}

// ---- TransferTransaction ----

const char* to_string(TerminalState state) {
  switch (state) {
    case TerminalState::kNone: return "none";
    case TerminalState::kCompleted: return "completed";
    case TerminalState::kAborted: return "aborted";
    case TerminalState::kTimedOut: return "timed_out";
    case TerminalState::kFailed: return "failed";
  }
  return "unknown";
}

TransferTransaction::TransferTransaction(std::string file_token,
                                         TlsSessionId control_session)
    : file_token_(std::move(file_token)),
      control_session_(std::move(control_session)) {}

void TransferTransaction::set_terminal_handler(TerminalHandler handler) {
  terminal_handler_ = std::move(handler);
}

void TransferTransaction::finalize(TerminalState state) {
  if (finished()) return;  // first terminal event wins; late events drain
  state_ = state;
  if (terminal_handler_) terminal_handler_(state);
}

bool TransferTransaction::bind_data_channel(const TlsSessionId& data_session) {
  if (finished()) return false;
  if (data_session != control_session_) {
    finalize(TerminalState::kFailed);
    return false;
  }
  data_bound_ = true;
  return true;
}

void TransferTransaction::on_data_bytes(std::size_t n) {
  if (finished()) return;
  bytes_ += n;
}

void TransferTransaction::on_reply(const Reply& reply) {
  if (finished()) return;  // late 226/426 after abort or timeout: drained
  if (reply.code == 226) {
    finalize(TerminalState::kCompleted);
  } else if (reply.code == 426 || reply.code / 100 == 5) {
    finalize(TerminalState::kFailed);
  }
}

void TransferTransaction::abort() {
  if (finished()) return;
  draining_ = true;  // expect and swallow the server's late 426/226
  finalize(TerminalState::kAborted);
}

void TransferTransaction::on_timeout() {
  if (finished()) return;
  draining_ = true;  // a 226 may still arrive; it must not flip the outcome
  finalize(TerminalState::kTimedOut);
}

// ---- Session ----

Session::Session(Endpoint control_peer, TlsSessionId control_session,
                 PasvAddressPolicy pasv_policy)
    : control_peer_(std::move(control_peer)),
      control_session_(std::move(control_session)),
      pasv_policy_(pasv_policy) {}

std::optional<Endpoint> Session::data_endpoint_for(const Reply& pasv_reply) const {
  const auto advertised = parse_pasv_reply(pasv_reply);
  if (!advertised) return std::nullopt;
  return resolve_data_endpoint(*advertised, control_peer_, pasv_policy_);
}

std::optional<Endpoint> Session::data_endpoint_for_epsv(const Reply& epsv_reply) const {
  const auto port = parse_epsv_reply(epsv_reply);
  if (!port) return std::nullopt;
  return Endpoint{control_peer_.host, *port};
}

TransferTransaction Session::begin_transfer(std::string file_token) const {
  return TransferTransaction(std::move(file_token), control_session_);
}

}  // namespace dataeng
