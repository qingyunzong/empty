package nameconstraints

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func testPKI(t *testing.T) *pki {
	t.Helper()
	rootTmpl := &x509.Certificate{
		PermittedDNSDomains: []string{"example.test"},
		PermittedIPRanges:   cidrList("10.0.0.0/8"),
	}
	interTmpl := &x509.Certificate{
		ExcludedDNSDomains: []string{"blocked.example.test"},
	}
	return newPKI(t, rootTmpl, interTmpl)
}

func TestVerifyConnectionRejectsWildcardSAN(t *testing.T) {
	// No exclusion here: standard x509 verification accepts the wildcard
	// against the permitted subtree, so the adapter is the enforcing layer.
	pki := basePKI(t)
	chain := pki.leaf(t, &x509.Certificate{DNSNames: []string{"*.example.test"}})

	intermediates := x509.NewCertPool()
	intermediates.AddCert(pki.inter)
	if _, err := chain[0].Verify(x509.VerifyOptions{Roots: pki.rootPool, Intermediates: intermediates}); err != nil {
		t.Fatalf("standard verification baseline changed: %v", err)
	}

	err := VerifyVerifiedChains([][]*x509.Certificate{chain})
	if err == nil {
		t.Fatal("wildcard SAN must be rejected by the component")
	}
	if !errors.Is(err, ErrWildcardSAN) {
		t.Fatalf("expected ErrWildcardSAN, got %T: %v", err, err)
	}
}

func TestVerifyConnectionAcceptsValidChain(t *testing.T) {
	pki := testPKI(t)
	chain := pki.leaf(t, &x509.Certificate{
		DNSNames:    []string{"api.example.test"},
		IPAddresses: []net.IP{net.ParseIP("10.1.2.3")},
	})
	if err := VerifyVerifiedChains([][]*x509.Certificate{chain}); err != nil {
		t.Fatalf("valid chain must pass: %v", err)
	}

	blocked := pki.leaf(t, &x509.Certificate{DNSNames: []string{"blocked.example.test"}})
	if err := VerifyVerifiedChains([][]*x509.Certificate{blocked}); err == nil {
		t.Fatal("excluded subdomain must be rejected")
	}
}

func TestVerifyConnectionRejectsUnverifiedInput(t *testing.T) {
	if err := NewVerifier().VerifyConnection(tls.ConnectionState{}); !errors.Is(err, ErrNoVerifiedChain) {
		t.Fatalf("empty connection state: got %v, want ErrNoVerifiedChain", err)
	}
	if err := NewVerifier().VerifyPeerCertificate(nil, nil); !errors.Is(err, ErrNoVerifiedChain) {
		t.Fatalf("nil chains: got %v, want ErrNoVerifiedChain", err)
	}
}

func TestHandshakeFailureSendsNoApplicationData(t *testing.T) {
	// Only permitted subtree, no exclusions: Go's verifier allows the
	// wildcard leaf so any handshake failure is attributable to the adapter.
	pki := basePKI(t)
	goodCert := pki.leafTLSCertificate(t, &x509.Certificate{
		DNSNames: []string{"api.example.test"},
	})
	badWildcard := pki.leafTLSCertificate(t, &x509.Certificate{
		DNSNames: []string{"*.example.test"},
	})

	t.Run("client rejects server", func(t *testing.T) {
		clientConn, serverConn := bufferedPipe()
		serverTLS := tls.Server(serverConn, serverConfig(t, badWildcard, pki, false))
		clientTLS := tls.Client(clientConn, adapterClientConfig(pki, true))

		serverErr := make(chan error, 1)
		go func() { serverErr <- serverTLS.Handshake() }()
		if err := clientTLS.Handshake(); err == nil {
			t.Fatal("client adapter must abort the wildcard handshake")
		} else {
			clientTLS.Close()
		}

		select {
		case err := <-serverErr:
			if err == nil {
				t.Fatal("server handshake must also fail when the client aborts")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("server did not observe handshake failure")
		}

		// No application data can cross after failure: writes fail and the
		// adapter runs before any Read could return payload.
		payload := []byte("application-data")
		if _, err := clientTLS.Write(payload); err == nil {
			t.Fatal("write on failed handshake unexpectedly succeeded")
		} else if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("write after failed handshake: %v", err)
		}
		_ = serverTLS.Close()
	})

	t.Run("server-side rejection carries no app data", func(t *testing.T) {
		// In mutual TLS the server-side adapter runs against the client
		// certificate. Go's verifier accepts a wildcard client SAN, so the
		// adapter is what aborts before any application record is sent.
		mutual := basePKI(t)
		goodServer := mutual.leafTLSCertificate(t, &x509.Certificate{
			DNSNames: []string{"api.example.test"},
		})
		badClientCert := mutual.leafTLSCertificate(t, &x509.Certificate{
			DNSNames: []string{"*.example.test"},
		})
		clientConn, serverConn := bufferedPipe()
		serverTLS := tls.Server(serverConn, &tls.Config{
			Certificates:     []tls.Certificate{toTLSCert(t, goodServer)},
			ClientAuth:       tls.RequireAndVerifyClientCert,
			ClientCAs:        mutual.rootPool,
			VerifyConnection: NewVerifier().VerifyConnection,
			MinVersion:       tls.VersionTLS12,
		})
		clientTLS := tls.Client(clientConn, &tls.Config{
			Certificates: []tls.Certificate{toTLSCert(t, badClientCert)},
			RootCAs:      mutual.rootPool,
			ServerName:   "api.example.test",
			MinVersion:   tls.VersionTLS12,
		})

		serverErr := make(chan error, 1)
		go func() {
			err := serverTLS.Handshake()
			if err == nil {
				_, err = serverTLS.Write([]byte("never-sent"))
			}
			serverErr <- err
		}()

		// The client may surface the server's alert only on its next I/O, so
		// the authoritative signal is the server-side adapter error below.
		_ = clientTLS.Handshake()
		select {
		case err := <-serverErr:
			if err == nil {
				t.Fatal("server adapter must return an error and not write app data")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("server handshake did not terminate")
		}

		// Raw pipe never delivered an application record: post-failure reads
		// time out or error rather than returning payload.
		peek := make([]byte, 32)
		serverConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		if n, err := serverConn.Read(peek); err == nil {
			t.Fatalf("received %d plaintext bytes after failed handshake", n)
		}
		_ = clientTLS.Close()
		_ = serverTLS.Close()
	})

	t.Run("successful handshake carries app data", func(t *testing.T) {
		clientConn, serverConn := bufferedPipe()
		serverTLS := tls.Server(serverConn, serverConfig(t, goodCert, pki, false))
		clientTLS := tls.Client(clientConn, adapterClientConfig(pki, true))

		serverErr := make(chan error, 1)
		go func() {
			if err := serverTLS.Handshake(); err != nil {
				serverErr <- err
				return
			}
			buf := make([]byte, 64)
			n, err := serverTLS.Read(buf)
			if err != nil {
				serverErr <- err
				return
			}
			_, err = serverTLS.Write(buf[:n])
			serverErr <- err
		}()

		if err := clientTLS.Handshake(); err != nil {
			t.Fatalf("valid handshake failed: %v", err)
		}
		payload := []byte("ping")
		if _, err := clientTLS.Write(payload); err != nil {
			t.Fatalf("write: %v", err)
		}
		buf := make([]byte, 64)
		n, err := clientTLS.Read(buf)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if !bytes.Equal(buf[:n], payload) {
			t.Fatalf("echo = %q, want %q", buf[:n], payload)
		}
		if err := <-serverErr; err != nil && !errors.Is(err, io.EOF) {
			t.Fatalf("server goroutine: %v", err)
		}
		_ = clientTLS.Close()
		_ = serverTLS.Close()
	})
}

func TestServerRejectsClientCertificate(t *testing.T) {
	pki := basePKI(t)
	serverCert := pki.leafTLSCertificate(t, &x509.Certificate{DNSNames: []string{"api.example.test"}})
	badClient := pki.leafTLSCertificate(t, &x509.Certificate{
		DNSNames: []string{"*.example.test"},
	})

	clientConn, serverConn := bufferedPipe()
	serverTLS := tls.Server(serverConn, &tls.Config{
		Certificates:     []tls.Certificate{toTLSCert(t, serverCert)},
		ClientAuth:       tls.RequireAndVerifyClientCert,
		ClientCAs:        pki.rootPool,
		VerifyConnection: NewVerifier().VerifyConnection,
		MinVersion:       tls.VersionTLS12,
	})
	clientTLS := tls.Client(clientConn, &tls.Config{
		Certificates: []tls.Certificate{toTLSCert(t, badClient)},
		RootCAs:      pki.rootPool,
		ServerName:   "api.example.test",
		MinVersion:   tls.VersionTLS12,
	})

	serverErr := make(chan error, 1)
	go func() { serverErr <- serverTLS.Handshake() }()
	// The alert may only surface at the client on subsequent I/O; the
	// server's adapter error is the authoritative rejection signal.
	_ = clientTLS.Handshake()
	select {
	case err := <-serverErr:
		if err == nil {
			t.Fatal("server must reject the client certificate")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server handshake did not terminate")
	}
	_ = clientTLS.Close()
	_ = serverTLS.Close()
}

func TestVerifyPeerCertificateAdapter(t *testing.T) {
	pki := testPKI(t)
	chain := pki.leaf(t, &x509.Certificate{DNSNames: []string{"api.example.test"}})
	state := tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{chain}}
	if err := NewVerifier().VerifyPeerCertificate(nil, state.VerifiedChains); err != nil {
		t.Fatalf("VerifyPeerCertificate on valid chain: %v", err)
	}
}

func adapterClientConfig(pki *pki, withAdapter bool) *tls.Config {
	cfg := &tls.Config{
		RootCAs:    pki.rootPool,
		ServerName: "api.example.test",
		MinVersion: tls.VersionTLS12,
	}
	if withAdapter {
		cfg.VerifyConnection = NewVerifier().VerifyConnection
	}
	return cfg
}

func serverConfig(t *testing.T, cert tlsCert, pki *pki, adapter bool) *tls.Config {
	t.Helper()
	cfg := &tls.Config{
		Certificates: []tls.Certificate{toTLSCert(t, cert)},
		MinVersion:   tls.VersionTLS12,
	}
	if adapter {
		cfg.VerifyConnection = NewVerifier().VerifyConnection
	}
	return cfg
}

func toTLSCert(t *testing.T, c tlsCert) tls.Certificate {
	t.Helper()
	return tls.Certificate{
		Certificate: [][]byte{c.leaf.Raw, c.inter.Raw},
		PrivateKey:  c.key,
		Leaf:        c.leaf,
	}
}
