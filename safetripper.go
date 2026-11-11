package q206

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// ErrSSRF is the base error wrapping every rejection made by SafeRoundTripper.
// Use errors.Is(err, ErrSSRF) to tell policy rejections apart from transport errors.
var ErrSSRF = errors.New("ssrf protection: request rejected")

var (
	// ErrUserInfo is returned when the request URL carries a userinfo component.
	ErrUserInfo = fmt.Errorf("%w: userinfo is not allowed in URL", ErrSSRF)
	// ErrScheme is returned for any scheme other than http or https.
	ErrScheme = fmt.Errorf("%w: only http and https schemes are allowed", ErrSSRF)
	// ErrHost is returned when the URL has no host or the host is otherwise empty.
	ErrHost = fmt.Errorf("%w: missing or invalid host", ErrSSRF)
	// ErrPort is returned when the port is not a number in the range 1..65535.
	ErrPort = fmt.Errorf("%w: invalid port", ErrSSRF)
	// ErrDomainNotAllowed is returned when a name host is not in the allow list.
	ErrDomainNotAllowed = fmt.Errorf("%w: host is not in the domain allow list", ErrSSRF)
	// ErrIPNotAllowed is returned when a resolved or literal IP is outside AllowedCIDRs.
	ErrIPNotAllowed = fmt.Errorf("%w: IP address is outside the allowed prefixes", ErrSSRF)
	// ErrIPv4Mapped is returned when an IPv4-mapped IPv6 literal is used to bypass checks.
	ErrIPv4Mapped = fmt.Errorf("%w: IPv4-mapped IPv6 literal is not allowed", ErrSSRF)
	// ErrNoResolvedAddresses is returned when the resolver yields no usable address.
	ErrNoResolvedAddresses = fmt.Errorf("%w: resolver returned no addresses", ErrSSRF)
)

// Resolver resolves a host name to its IP addresses. Implementations must return
// every address the host currently resolves to; SafeRoundTripper validates the
// full set before any dial is attempted.
type Resolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// Dialer opens a network connection to a fully validated IP:port endpoint.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// Config configures a SafeRoundTripper.
type Config struct {
	// AllowedHosts is the domain allow list. Entries match a host exactly,
	// or when prefixed with "." match the entry itself and every subdomain
	// (e.g. ".example.com" matches "example.com" and "api.example.com").
	// Matching is case-insensitive. IP literals are checked against
	// AllowedCIDRs and do not need to appear here.
	AllowedHosts []string

	// AllowedCIDRs is the list of IP prefixes every resolved address must
	// belong to. A request is rejected if any single resolved address falls
	// outside the prefixes.
	AllowedCIDRs []*net.IPNet

	// Resolver is used to look up name hosts. Defaults to a net.Resolver.
	Resolver Resolver

	// Dialer performs the actual TCP connection after all checks pass.
	// Defaults to a *net.Dialer with a 10 second timeout.
	Dialer Dialer

	// MaxRedirects limits the number of HTTP redirects followed. Each hop is
	// re-validated from scratch. Defaults to 10 when zero; negative disables
	// redirects entirely.
	MaxRedirects int

	// TLSClientConfig is cloned and used for HTTPS handshakes. The ServerName
	// field is always overridden with the original request host name.
	TLSClientConfig *tls.Config
}

type ctxKey int

const (
	ctxKeyPinnedIP ctxKey = iota
	ctxKeyHostname
)

// SafeRoundTripper is an http.RoundTripper that enforces SSRF protection on
// every request, including each redirect hop. It never uses a proxy and dials
// only IP addresses that were validated during the same RoundTrip call.
type SafeRoundTripper struct {
	allowedHosts  map[string]struct{}
	allowedSuffix []string
	allowedCIDRs  []*net.IPNet
	resolver      Resolver
	dialer        Dialer
	maxRedirects  int
	tlsConfig     *tls.Config
	transport     *http.Transport
}

// New constructs a SafeRoundTripper from cfg.
func New(cfg Config) (*SafeRoundTripper, error) {
	if len(cfg.AllowedCIDRs) == 0 {
		return nil, fmt.Errorf("ssrf protection: at least one allowed IP prefix is required")
	}

	resolver := cfg.Resolver
	if resolver == nil {
		resolver = &net.Resolver{}
	}
	dialer := cfg.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 10 * time.Second}
	}
	maxRedirects := cfg.MaxRedirects
	if maxRedirects == 0 {
		maxRedirects = 10
	}

	rt := &SafeRoundTripper{
		allowedHosts: make(map[string]struct{}),
		allowedCIDRs: cfg.AllowedCIDRs,
		resolver:     resolver,
		dialer:       dialer,
		maxRedirects: maxRedirects,
		tlsConfig:    cfg.TLSClientConfig,
	}
	for _, host := range cfg.AllowedHosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if host == "" {
			continue
		}
		if strings.HasPrefix(host, ".") {
			rt.allowedSuffix = append(rt.allowedSuffix, host)
			rt.allowedHosts[strings.TrimPrefix(host, ".")] = struct{}{}
			continue
		}
		rt.allowedHosts[host] = struct{}{}
	}

	rt.transport = &http.Transport{
		Proxy:               nil,
		DialContext:         rt.dialContext,
		DialTLSContext:      rt.dialTLSContext,
		TLSClientConfig:     cfg.TLSClientConfig,
		MaxIdleConns:        100,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	return rt, nil
}

// RoundTrip implements http.RoundTripper. It validates the request, resolves
// and pins the target IP, then delegates the exchange to a proxy-free transport.
func (s *SafeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	ips, err := s.validate(req)
	if err != nil {
		return nil, err
	}

	hostname := req.URL.Hostname()
	ctx := context.WithValue(req.Context(), ctxKeyPinnedIP, ips[0])
	ctx = context.WithValue(ctx, ctxKeyHostname, hostname)
	return s.transport.RoundTrip(req.WithContext(ctx))
}

// CheckRedirect is intended to be used as http.Client.CheckRedirect. It
// re-validates every redirect target before the client follows it, so a
// cross-domain or internal-IP redirect is blocked before any dial.
func (s *SafeRoundTripper) CheckRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= s.maxRedirects {
		return fmt.Errorf("ssrf protection: stopped after %d redirects: %w", s.maxRedirects, http.ErrUseLastResponse)
	}
	_, err := s.validate(req)
	return err
}

// NewClient returns an *http.Client whose transport is this round tripper and
// whose redirects are re-validated on every hop.
func (s *SafeRoundTripper) NewClient() *http.Client {
	return &http.Client{
		Transport: s,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return s.CheckRedirect(req, via)
		},
	}
}

// validate runs the full policy check and returns the validated IP addresses.
// It never reaches the dialer: a returned error means no connection attempt.
func (s *SafeRoundTripper) validate(req *http.Request) ([]net.IP, error) {
	u := req.URL
	if u == nil {
		return nil, ErrHost
	}
	if u.User != nil {
		return nil, ErrUserInfo
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("%w: %q", ErrScheme, u.Scheme)
	}

	host := u.Hostname()
	if host == "" {
		return nil, ErrHost
	}

	// Check the mapped-literal bypass before ParseIP: a 16-byte mapped IP is
	// otherwise treated exactly like its embedded IPv4 address.
	if isIPv4MappedHost(host, u.Host) {
		return nil, ErrIPv4Mapped
	}

	if port := u.Port(); port != "" {
		portNum, err := parsePort(port)
		if err != nil {
			return nil, err
		}
		if portNum < 1 || portNum > 65535 {
			return nil, fmt.Errorf("%w: %d", ErrPort, portNum)
		}
	}

	if ip := net.ParseIP(host); ip != nil {
		if err := s.checkIP(ip); err != nil {
			return nil, err
		}
		return []net.IP{ip}, nil
	}

	if !s.hostAllowed(host) {
		return nil, fmt.Errorf("%w: %q", ErrDomainNotAllowed, host)
	}

	addrs, err := s.resolver.LookupIPAddr(req.Context(), host)
	if err != nil {
		return nil, fmt.Errorf("ssrf protection: name resolution failed for %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%w: %q", ErrNoResolvedAddresses, host)
	}

	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if err := s.checkIP(addr.IP); err != nil {
			return nil, err
		}
		ips = append(ips, addr.IP)
	}
	return ips, nil
}

func (s *SafeRoundTripper) checkIP(ip net.IP) error {
	for _, network := range s.allowedCIDRs {
		if network.Contains(ip) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrIPNotAllowed, ip.String())
}

func (s *SafeRoundTripper) hostAllowed(host string) bool {
	host = strings.ToLower(host)
	if _, ok := s.allowedHosts[host]; ok {
		return true
	}
	for _, suffix := range s.allowedSuffix {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

func (s *SafeRoundTripper) dialContext(ctx context.Context, _, address string) (net.Conn, error) {
	pinnedIP, ok := ctx.Value(ctxKeyPinnedIP).(net.IP)
	if !ok {
		return nil, fmt.Errorf("%w: no validated address available for dial", ErrSSRF)
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("%w: malformed dial address %q", ErrSSRF, address)
	}
	target := net.JoinHostPort(pinnedIP.String(), port)
	return s.dialer.DialContext(ctx, "tcp", target)
}

func (s *SafeRoundTripper) dialTLSContext(ctx context.Context, _, address string) (net.Conn, error) {
	hostname, _ := ctx.Value(ctxKeyHostname).(string)
	conn, err := s.dialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}

	tlsConfig := &tls.Config{}
	if s.tlsConfig != nil {
		tlsConfig = s.tlsConfig.Clone()
	}
	// The certificate and SNI stay bound to the original domain name even
	// though the TCP connection is pinned to the validated IP.
	tlsConfig.ServerName = hostname

	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return tlsConn, nil
}

func parsePort(port string) (int, error) {
	value := 0
	for i := 0; i < len(port); i++ {
		ch := port[i]
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("%w: %q", ErrPort, port)
		}
		value = value*10 + int(ch-'0')
		if value > 65535 {
			return 0, fmt.Errorf("%w: %q", ErrPort, port)
		}
	}
	if value == 0 {
		return 0, fmt.Errorf("%w: %q", ErrPort, port)
	}
	return value, nil
}

// isIPv4MappedHost reports whether the host is an IPv6 literal embedding an
// IPv4 address (e.g. "[::ffff:169.254.1.1]"), which could smuggle an internal
// IPv4 address past IPv4-oriented checks. host is the bracket- and port-free
// form from URL.Hostname; rawHost retains any port and brackets.
func isIPv4MappedHost(host, rawHost string) bool {
	if !strings.Contains(host, ":") || !strings.HasPrefix(rawHost, "[") {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	// An IPv6 literal that resolves to an IPv4 form is a mapped (or
	// compatible) address embedding an IPv4 endpoint.
	return ip.To4() != nil
}

var (
	_ http.RoundTripper = (*SafeRoundTripper)(nil)
	_ Resolver          = (*net.Resolver)(nil)
	_ Dialer            = (*net.Dialer)(nil)
)
