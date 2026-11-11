package nameconstraints

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"
)

type pki struct {
	root     *x509.Certificate
	intKey   *ecdsa.PrivateKey
	inter    *x509.Certificate
	rootPool *x509.CertPool
}

func basePKI(t *testing.T) *pki {
	return newPKI(t, &x509.Certificate{}, &x509.Certificate{})
}

func newPKI(t *testing.T, rootTmpl, interTmpl *x509.Certificate) *pki {
	t.Helper()

	rootKey := mustKey()
	baseTmpl(rootTmpl, 1)
	rootTmpl.Subject = pkix.Name{CommonName: "test-root"}
	rootTmpl.IsCA = true
	rootTmpl.BasicConstraintsValid = true
	rootTmpl.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	root := mustCert(rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)

	intKey := mustKey()
	baseTmpl(interTmpl, 2)
	interTmpl.Subject = pkix.Name{CommonName: "test-intermediate"}
	interTmpl.IsCA = true
	interTmpl.BasicConstraintsValid = true
	interTmpl.KeyUsage = x509.KeyUsageCertSign
	inter := mustCert(interTmpl, root, &intKey.PublicKey, rootKey)

	pool := x509.NewCertPool()
	pool.AddCert(root)
	return &pki{root: root, intKey: intKey, inter: inter, rootPool: pool}
}

func (p *pki) leaf(t *testing.T, tmpl *x509.Certificate) []*x509.Certificate {
	t.Helper()
	key := mustKey()
	baseTmpl(tmpl, 3)
	tmpl.Subject = pkix.Name{CommonName: "test-leaf"}
	tmpl.KeyUsage = x509.KeyUsageDigitalSignature
	tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
	leaf := mustCert(tmpl, p.inter, &key.PublicKey, p.intKey)
	return []*x509.Certificate{leaf, p.inter, p.root}
}

func (p *pki) leafTLSCertificate(t *testing.T, tmpl *x509.Certificate) tlsCert {
	t.Helper()
	key := mustKey()
	baseTmpl(tmpl, 4)
	tmpl.Subject = pkix.Name{CommonName: "test-leaf"}
	tmpl.KeyUsage = x509.KeyUsageDigitalSignature
	tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
	leaf := mustCert(tmpl, p.inter, &key.PublicKey, p.intKey)
	return tlsCert{leaf: leaf, inter: p.inter, key: key}
}

type tlsCert struct {
	leaf  *x509.Certificate
	inter *x509.Certificate
	key   *ecdsa.PrivateKey
}

func mustKey() *ecdsa.PrivateKey {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return key
}

func baseTmpl(tmpl *x509.Certificate, serial int64) {
	tmpl.SerialNumber = big.NewInt(serial)
	tmpl.NotBefore = time.Now().Add(-time.Hour)
	tmpl.NotAfter = time.Now().Add(24 * time.Hour)
	tmpl.BasicConstraintsValid = true
}

func mustCert(tmpl, parent *x509.Certificate, pub, priv any) *x509.Certificate {
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, priv)
	if err != nil {
		panic(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		panic(err)
	}
	return cert
}

func cidrList(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, network, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, network)
	}
	return out
}

// bufferedPipe returns a connected pair of in-memory connections whose
// writes never block waiting for a reader. net.Pipe is fully synchronous
// and deadlocks when a failing handshake leaves one side writing an alert
// while the other side has already returned.
func bufferedPipe() (net.Conn, net.Conn) {
	a := &bufferedConn{ch: make(chan []byte, 64), done: make(chan struct{})}
	b := &bufferedConn{ch: make(chan []byte, 64), done: make(chan struct{})}
	a.peer, b.peer = b, a
	return a, b
}

type bufferedConn struct {
	peer         *bufferedConn
	ch           chan []byte
	done         chan struct{}
	once         sync.Once
	buf          []byte
	readDeadline time.Time
}

func (c *bufferedConn) Read(b []byte) (int, error) {
	if len(c.buf) == 0 {
		var timer *time.Timer
		var timerCh <-chan time.Time
		if !c.readDeadline.IsZero() {
			timer = time.NewTimer(time.Until(c.readDeadline))
			timerCh = timer.C
			defer timer.Stop()
		}
		select {
		case chunk, ok := <-c.ch:
			if !ok {
				return 0, net.ErrClosed
			}
			c.buf = chunk
		case <-c.done:
			return 0, net.ErrClosed
		case <-timerCh:
			return 0, errTimeout
		}
	}
	n := copy(b, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *bufferedConn) Write(b []byte) (int, error) {
	chunk := append([]byte(nil), b...)
	select {
	case c.peer.ch <- chunk:
		return len(b), nil
	case <-c.done:
		return 0, net.ErrClosed
	case <-c.peer.done:
		return 0, net.ErrClosed
	}
}

func (c *bufferedConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return nil
}

func (c *bufferedConn) LocalAddr() net.Addr  { return pipeAddr("local") }
func (c *bufferedConn) RemoteAddr() net.Addr { return pipeAddr("remote") }
func (c *bufferedConn) SetDeadline(t time.Time) error {
	c.readDeadline = t
	return nil
}
func (c *bufferedConn) SetReadDeadline(t time.Time) error {
	c.readDeadline = t
	return nil
}
func (c *bufferedConn) SetWriteDeadline(time.Time) error { return nil }

type pipeAddr string

func (p pipeAddr) Network() string { return "pipe" }
func (p pipeAddr) String() string  { return string(p) }

var errTimeout = timeoutError{}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
