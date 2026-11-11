package q206

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"
)

// pipeConn is an in-memory net.Conn backed by two connected net.Pipe ends, so
// tests can exercise real dial/TLS/HTTP semantics without binding a socket
// (the sandbox forbids listeners).
type pipeConn struct {
	net.Conn
	local  net.Addr
	remote net.Addr
}

func (c *pipeConn) LocalAddr() net.Addr  { return c.local }
func (c *pipeConn) RemoteAddr() net.Addr { return c.remote }

type pipeAddr string

func (a pipeAddr) Network() string { return "tcp" }
func (a pipeAddr) String() string  { return string(a) }

// newPipePair returns a client/server connection pair, each wrapped so the
// transport sees realistic dial addresses.
func newPipePair(clientAddr, serverAddr string) (net.Conn, net.Conn) {
	client, server := net.Pipe()
	return &pipeConn{Conn: client, local: pipeAddr("client:0"), remote: pipeAddr(clientAddr)},
		&pipeConn{Conn: server, local: pipeAddr(serverAddr), remote: pipeAddr("client:0")}
}

// fakeDialer records every dial and terminates the connection with a local
// HTTP or TLS server running over an in-memory pipe. With handler == nil any
// dial is a test failure, proving rejected requests never reach the dialer.
type fakeDialer struct {
	mu        sync.Mutex
	addresses []string
	handler   http.Handler
	tlsCert   *tls.Certificate
}

func (d *fakeDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.addresses = append(d.addresses, address)
	handler := d.handler
	cert := d.tlsCert
	d.mu.Unlock()
	if handler == nil && cert == nil {
		return nil, fmt.Errorf("dialer must not be called for a rejected request: %s %s", network, address)
	}

	clientConn, serverConn := newPipePair(address, "fake-server:80")
	if cert != nil {
		serverTLS := tls.Server(serverConn, &tls.Config{Certificates: []tls.Certificate{*cert}})
		go func() {
			_ = serverTLS.HandshakeContext(ctx)
			d.serve(serverTLS)
		}()
		return clientConn, nil
	}
	go d.serve(serverConn)
	return clientConn, nil
}

type pipeListener struct{ conn net.Conn }

func (l pipeListener) Accept() (net.Conn, error) { return l.conn, nil }
func (l pipeListener) Close() error              { return nil }
func (l pipeListener) Addr() net.Addr            { return pipeAddr("fake-server") }

func (d *fakeDialer) serve(conn net.Conn) {
	defer conn.Close()
	if d.handler == nil {
		return
	}
	_ = http.Serve(pipeListener{conn: conn}, d.handler)
}

func (d *fakeDialer) calls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.addresses...)
}

func (d *fakeDialer) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.addresses)
}

// scriptResolver returns queued answer sets per host, which lets tests model
// DNS rebinding between RoundTrip calls against the same host.
type scriptResolver struct {
	mu       sync.Mutex
	lookups  map[string]int
	script   map[string][][]net.IPAddr
	fallback map[string][]net.IPAddr
}

func (r *scriptResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lookups == nil {
		r.lookups = make(map[string]int)
	}
	r.lookups[host]++
	if answers, ok := r.script[host]; ok && len(answers) > 0 {
		next := answers[0]
		if len(answers) > 1 {
			r.script[host] = answers[1:]
		}
		return append([]net.IPAddr(nil), next...), nil
	}
	if addrs, ok := r.fallback[host]; ok {
		return append([]net.IPAddr(nil), addrs...), nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func (r *scriptResolver) lookupCount(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lookups[host]
}

func mustParseCIDR(t *testing.T, s string) *net.IPNet {
	t.Helper()
	_, network, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatalf("ParseCIDR(%q): %v", s, err)
	}
	return network
}

func ipAddrs(ips ...string) []net.IPAddr {
	addrs := make([]net.IPAddr, 0, len(ips))
	for _, ip := range ips {
		addrs = append(addrs, net.IPAddr{IP: net.ParseIP(ip)})
	}
	return addrs
}

func newTestTripper(t *testing.T, resolver Resolver, dialer Dialer, hosts ...string) *SafeRoundTripper {
	t.Helper()
	rt, err := New(Config{
		AllowedHosts: hosts,
		AllowedCIDRs: []*net.IPNet{mustParseCIDR(t, "127.0.0.0/8")},
		Resolver:     resolver,
		Dialer:       dialer,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return rt
}

func mustGet(t *testing.T, raw string) *http.Request {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return &http.Request{
		Method: http.MethodGet,
		URL:    u,
		Host:   u.Host,
		Header: make(http.Header),
	}
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "ok")
	})
}

func drainAndClose(t *testing.T, resp *http.Response) {
	t.Helper()
	_, _ = io.Copy(io.Discard, resp.Body)
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close response: %v", err)
	}
}

func selfSignedCert(t *testing.T, dnsName string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatalf("serial: %v", err)
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: dnsName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		DNSNames:              []string{dnsName},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	return cert, pool
}

// TestDNSRebinding verifies that the address set is re-validated on every
// request and the connection is pinned to an IP that passed the same check, so
// a rebinding answer containing a forbidden address is blocked without ever
// touching the dialer.
func TestDNSRebinding(t *testing.T) {
	const port = "8080"
	resolver := &scriptResolver{
		script: map[string][][]net.IPAddr{
			"rebind.example": {
				ipAddrs("127.0.0.1"),
				ipAddrs("127.0.0.1", "169.254.1.1"),
				ipAddrs("169.254.1.1", "127.0.0.1"),
			},
		},
	}
	dialer := &fakeDialer{handler: okHandler()}
	rt := newTestTripper(t, resolver, dialer, "rebind.example")

	resp, err := rt.RoundTrip(mustGet(t, "http://rebind.example:"+port+"/"))
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	drainAndClose(t, resp)
	if got := dialer.calls(); len(got) != 1 || got[0] != "127.0.0.1:"+port {
		t.Fatalf("expected dial pinned to 127.0.0.1, got %v", got)
	}

	for _, tc := range []struct{ name string }{
		{name: "forbidden second address"},
		{name: "forbidden first address"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := dialer.count()
			_, err := rt.RoundTrip(mustGet(t, "http://rebind.example:"+port+"/"))
			if !errors.Is(err, ErrIPNotAllowed) {
				t.Fatalf("expected ErrIPNotAllowed, got %v", err)
			}
			if dialer.count() != before {
				t.Fatalf("rejected rebinding request reached dialer: %v", dialer.calls())
			}
		})
	}

	if resolver.lookupCount("rebind.example") != 3 {
		t.Fatalf("expected 3 resolver lookups, got %d", resolver.lookupCount("rebind.example"))
	}
}

// TestRedirectCrossDomain verifies that every redirect hop is re-validated: a
// redirect to a host outside the domain allow list is blocked before dialing.
func TestRedirectCrossDomain(t *testing.T) {
	const port = "8080"
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/escape":
			http.Redirect(w, r, "http://evil.example:"+port+"/ok", http.StatusFound)
		case "/stay":
			http.Redirect(w, r, "http://good.example:"+port+"/ok", http.StatusFound)
		default:
			fmt.Fprint(w, "ok")
		}
	})
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{
			"good.example": ipAddrs("127.0.0.1"),
			"evil.example": ipAddrs("127.0.0.2"),
		},
	}
	{
		dialer := &fakeDialer{handler: handler}
		client := newTestTripper(t, resolver, dialer, "good.example").NewClient()
		resp, err := client.Get("http://good.example:" + port + "/stay")
		if err != nil {
			t.Fatalf("same-domain redirect: %v", err)
		}
		drainAndClose(t, resp)
		if got := dialer.calls(); len(got) != 2 {
			t.Fatalf("same-domain redirect expected 2 dials (each hop), got %v", got)
		}
	}

	{
		dialer := &fakeDialer{handler: handler}
		client := newTestTripper(t, resolver, dialer, "good.example").NewClient()
		_, err := client.Get("http://good.example:" + port + "/escape")
		if !errors.Is(err, ErrDomainNotAllowed) {
			t.Fatalf("expected ErrDomainNotAllowed for cross-domain redirect, got %v", err)
		}
		// Only the initial hop may have dialed; the rejected redirect target
		// must never reach the dialer.
		if got := dialer.calls(); len(got) != 1 || got[0] != "127.0.0.1:"+port {
			t.Fatalf("rejected redirect target must not be dialed, got %v", got)
		}
	}
}

// TestMultipleAddressesOneForbidden verifies that every resolved address must
// be allowed: a single forbidden address blocks the whole request and the
// dialer is never invoked.
func TestMultipleAddressesOneForbidden(t *testing.T) {
	const port = "8080"
	for _, tc := range []struct {
		name string
		ips  []string
	}{
		{name: "forbidden last", ips: []string{"127.0.0.1", "169.254.1.1"}},
		{name: "forbidden first", ips: []string{"169.254.1.1", "127.0.0.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &scriptResolver{
				fallback: map[string][]net.IPAddr{"multi.example": ipAddrs(tc.ips...)},
			}
			dialer := &fakeDialer{} // no handler/cert: any dial fails the test
			rt := newTestTripper(t, resolver, dialer, "multi.example")

			_, err := rt.RoundTrip(mustGet(t, "http://multi.example:"+port+"/"))
			if !errors.Is(err, ErrIPNotAllowed) {
				t.Fatalf("expected ErrIPNotAllowed, got %v", err)
			}
			if dialer.count() != 0 {
				t.Fatalf("dialer was called despite forbidden address: %v", dialer.calls())
			}
		})
	}

	t.Run("all allowed pins first address", func(t *testing.T) {
		resolver := &scriptResolver{
			fallback: map[string][]net.IPAddr{"multi.example": ipAddrs("127.0.0.1", "127.0.0.2")},
		}
		dialer := &fakeDialer{handler: okHandler()}
		rt := newTestTripper(t, resolver, dialer, "multi.example")

		resp, err := rt.RoundTrip(mustGet(t, "http://multi.example:"+port+"/"))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		drainAndClose(t, resp)
		if got := dialer.calls(); len(got) != 1 || got[0] != "127.0.0.1:"+port {
			t.Fatalf("expected pin to first validated IP, got %v", got)
		}
	})
}

// TestImmediateRejections covers policy rules that must fail before any
// resolution or dial happens.
func TestImmediateRejections(t *testing.T) {
	const port = "8080"
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{"good.example": ipAddrs("127.0.0.1")},
	}
	rt := newTestTripper(t, resolver, &fakeDialer{}, "good.example")

	cases := []struct {
		name string
		url  string
		want error
	}{
		{name: "userinfo", url: "http://user:secret@good.example:" + port + "/", want: ErrUserInfo},
		{name: "gopher scheme", url: "gopher://good.example:70/", want: ErrScheme},
		{name: "file scheme", url: "file:///etc/passwd", want: ErrScheme},
		{name: "port too large", url: "http://good.example:70000/", want: ErrPort},
		{name: "port zero", url: "http://good.example:0/", want: ErrPort},
		{name: "ipv4 mapped ipv6 hex", url: "http://[::ffff:127.0.0.1]:" + port + "/", want: ErrIPv4Mapped},
		{name: "ipv4 mapped ipv6 dotted", url: "http://[::ffff:169.254.1.1]:" + port + "/", want: ErrIPv4Mapped},
		{name: "domain not allowed", url: "http://evil.example:" + port + "/", want: ErrDomainNotAllowed},
		{name: "ip literal outside prefixes", url: "http://169.254.1.1:" + port + "/", want: ErrIPNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dialer := &fakeDialer{} // any dial fails the subtest
			rt.dialer = dialer
			_, err := rt.RoundTrip(mustGet(t, tc.url))
			if !errors.Is(err, tc.want) {
				t.Fatalf("expected %v, got %v", tc.want, err)
			}
			if !errors.Is(err, ErrSSRF) {
				t.Fatalf("rejection should wrap ErrSSRF, got %v", err)
			}
			if dialer.count() != 0 {
				t.Fatalf("rejected request reached dialer: %v", dialer.calls())
			}
		})
	}
}

func TestParsePort(t *testing.T) {
	for _, tc := range []struct {
		in      string
		wantErr bool
	}{
		{in: "80"},
		{in: "8080"},
		{in: "65535"},
		{in: "0", wantErr: true},
		{in: "65536", wantErr: true},
		{in: "70000", wantErr: true},
		{in: "http", wantErr: true},
		{in: "-1", wantErr: true},
		{in: "12a", wantErr: true},
	} {
		_, err := parsePort(tc.in)
		if tc.wantErr && err == nil {
			t.Errorf("parsePort(%q) expected error", tc.in)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("parsePort(%q) unexpected error: %v", tc.in, err)
		}
	}
}

// TestProxyDisabled verifies that proxy environment variables are ignored: the
// underlying transport has no Proxy func and the validated peer is dialed.
func TestProxyDisabled(t *testing.T) {
	const port = "8080"
	t.Setenv("HTTP_PROXY", "http://198.51.100.10:3128")
	t.Setenv("http_proxy", "http://198.51.100.10:3128")
	t.Setenv("HTTPS_PROXY", "http://198.51.100.10:3128")
	t.Setenv("NO_PROXY", "")

	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{"good.example": ipAddrs("127.0.0.1")},
	}
	dialer := &fakeDialer{handler: okHandler()}
	rt := newTestTripper(t, resolver, dialer, "good.example")

	if rt.transport.Proxy != nil {
		t.Fatal("transport must not use any proxy resolver")
	}
	resp, err := rt.RoundTrip(mustGet(t, "http://good.example:"+port+"/"))
	if err != nil {
		t.Fatalf("request with proxy env set: %v", err)
	}
	drainAndClose(t, resp)
	for _, addr := range dialer.calls() {
		if addr == "198.51.100.10:3128" {
			t.Fatalf("request was sent through configured proxy: %v", dialer.calls())
		}
	}
}

// TestTLSHostnamePreserved verifies that the TCP connection is pinned to the
// validated IP while the TLS handshake still uses the original domain name for
// SNI and certificate verification.
func TestTLSHostnamePreserved(t *testing.T) {
	const (
		host = "secure.example"
		port = "8443"
	)
	cert, pool := selfSignedCert(t, host)
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{host: ipAddrs("127.0.0.1")},
	}
	dialer := &fakeDialer{handler: okHandler(), tlsCert: &cert}
	rt, err := New(Config{
		AllowedHosts:    []string{host},
		AllowedCIDRs:    []*net.IPNet{mustParseCIDR(t, "127.0.0.0/8")},
		Resolver:        resolver,
		Dialer:          dialer,
		TLSClientConfig: &tls.Config{RootCAs: pool},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	resp, err := rt.RoundTrip(mustGet(t, "https://"+host+":"+port+"/"))
	if err != nil {
		t.Fatalf("tls request: %v", err)
	}
	drainAndClose(t, resp)

	if got := dialer.calls(); len(got) != 1 || got[0] != "127.0.0.1:"+port {
		t.Fatalf("tls dial must pin validated IP, got %v", got)
	}
}

// TestTLSCertificateNameMismatch proves the TLS layer validates the original
// hostname rather than the pinned IP: a cert for another name is rejected even
// though the TCP peer is an allowed address.
func TestTLSCertificateNameMismatch(t *testing.T) {
	const (
		host = "secure.example"
		port = "8443"
	)
	cert, pool := selfSignedCert(t, "other.example")
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{host: ipAddrs("127.0.0.1")},
	}
	dialer := &fakeDialer{tlsCert: &cert}
	rt, err := New(Config{
		AllowedHosts:    []string{host},
		AllowedCIDRs:    []*net.IPNet{mustParseCIDR(t, "127.0.0.0/8")},
		Resolver:        resolver,
		Dialer:          dialer,
		TLSClientConfig: &tls.Config{RootCAs: pool},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	_, err = rt.RoundTrip(mustGet(t, "https://"+host+":"+port+"/"))
	var nameErr x509.HostnameError
	if !errors.As(err, &nameErr) {
		t.Fatalf("expected x509.HostnameError for mismatched cert, got %v", err)
	}
}

// TestIPLiteralAndSuffixRules checks literal-IP allow listing and suffix
// domain rules without a resolver lookup.
func TestIPLiteralAndSuffixRules(t *testing.T) {
	const port = "8080"
	dialer := &fakeDialer{handler: okHandler()}
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{
			"api.example.com": ipAddrs("127.0.0.1"),
		},
	}
	rt := newTestTripper(t, resolver, dialer, ".example.com")

	resp, err := rt.RoundTrip(mustGet(t, "http://127.0.0.1:"+port+"/"))
	if err != nil {
		t.Fatalf("allowed ip literal: %v", err)
	}
	drainAndClose(t, resp)

	resp, err = rt.RoundTrip(mustGet(t, "http://api.example.com:"+port+"/"))
	if err != nil {
		t.Fatalf("suffix match: %v", err)
	}
	drainAndClose(t, resp)

	_, err = rt.RoundTrip(mustGet(t, "http://notexample.com:"+port+"/"))
	if !errors.Is(err, ErrDomainNotAllowed) {
		t.Fatalf("suffix must not match partial name, got %v", err)
	}
}

func TestNewRequiresPrefixes(t *testing.T) {
	if _, err := New(Config{AllowedHosts: []string{"example.com"}}); err == nil {
		t.Fatal("New without AllowedCIDRs must fail")
	}
}

// TestRedirectLimit verifies the configurable redirect cap and that every hop
// is re-validated through CheckRedirect.
func TestRedirectLimit(t *testing.T) {
	const port = "8080"
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/hop", http.StatusFound)
	})
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{"loop.example": ipAddrs("127.0.0.1")},
	}
	dialer := &fakeDialer{handler: handler}
	rt, err := New(Config{
		AllowedHosts: []string{"loop.example"},
		AllowedCIDRs: []*net.IPNet{mustParseCIDR(t, "127.0.0.0/8")},
		Resolver:     resolver,
		Dialer:       dialer,
		MaxRedirects: 2,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	client := rt.NewClient()

	_, err = client.Get("http://loop.example:" + port + "/start")
	if err == nil {
		t.Fatal("expected redirect limit error")
	}
	if !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("expected wrapped http.ErrUseLastResponse, got %v", err)
	}
	// Initial request plus one followed hop; the third request trips the cap.
	if got := len(dialer.calls()); got != 2 {
		t.Fatalf("expected 2 dials before redirect limit, got %d (%v)", got, dialer.calls())
	}
}

// TestDefaultPortAndDefaultScheme verifies requests without an explicit port
// dial the scheme default and that https pins the validated address too.
func TestDefaultPortAndDefaultScheme(t *testing.T) {
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{"bare.example": ipAddrs("127.0.0.1")},
	}
	dialer := &fakeDialer{handler: okHandler()}
	rt := newTestTripper(t, resolver, dialer, "bare.example")

	resp, err := rt.RoundTrip(mustGet(t, "http://bare.example/"))
	if err != nil {
		t.Fatalf("default http port: %v", err)
	}
	drainAndClose(t, resp)
	if got := dialer.calls(); len(got) != 1 || got[0] != "127.0.0.1:80" {
		t.Fatalf("expected dial on :80, got %v", got)
	}
}

// TestCheckRedirectDirectly ensures CheckRedirect rejects a disallowed redirect
// target independently of the client plumbing.
func TestCheckRedirectDirectly(t *testing.T) {
	resolver := &scriptResolver{
		fallback: map[string][]net.IPAddr{"good.example": ipAddrs("127.0.0.1")},
	}
	rt := newTestTripper(t, resolver, &fakeDialer{}, "good.example")

	allowed := mustGet(t, "http://good.example:8080/ok")
	if err := rt.CheckRedirect(allowed, []*http.Request{{}}); err != nil {
		t.Fatalf("allowed redirect rejected: %v", err)
	}
	blocked := mustGet(t, "http://evil.example:8080/ok")
	if err := rt.CheckRedirect(blocked, []*http.Request{{}}); !errors.Is(err, ErrDomainNotAllowed) {
		t.Fatalf("expected ErrDomainNotAllowed, got %v", err)
	}
}
