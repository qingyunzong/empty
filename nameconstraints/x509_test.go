package nameconstraints

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"testing"
	"time"
)

func baseTime(offsetHours int) time.Time {
	return time.Now().Add(time.Duration(offsetHours) * time.Hour)
}

func TestX509SelfIssuedIntermediateAppliesConstraints(t *testing.T) {
	rootKey := mustKey()
	rootTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "self-issued-root"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
		PermittedDNSDomains:   []string{"example.test"},
	}
	root := mustCert(rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)

	// Self-issued intermediate: identical subject and issuer naming.
	selfKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	selfTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "self-issued-root"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
		PermittedDNSDomains:   []string{"sub.example.test"},
		DNSNames:              []string{"forbidden.other.test"},
	}
	selfCert := mustCert(selfTmpl, root, &selfKey.PublicKey, rootKey)
	if !isSelfIssued(selfCert) {
		t.Fatal("test setup: intermediate must be self-issued")
	}

	leafKey := mustKey()
	leafTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(3),
		Subject:               pkix.Name{CommonName: "leaf"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		BasicConstraintsValid: true,
		DNSNames:              []string{"host.sub.example.test"},
	}
	leaf := mustCert(leafTmpl, selfCert, &leafKey.PublicKey, selfKey)

	chain := []*x509.Certificate{leaf, selfCert, root}
	if err := VerifyVerifiedChains([][]*x509.Certificate{chain}); err != nil {
		t.Fatalf("self-issued intermediate name check must be skipped while its constraints apply: %v", err)
	}

	leafTmpl2 := &x509.Certificate{
		SerialNumber:          big.NewInt(4),
		Subject:               pkix.Name{CommonName: "leaf2"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		BasicConstraintsValid: true,
		DNSNames:              []string{"host.example.test"},
	}
	leaf2 := mustCert(leafTmpl2, selfCert, &leafKey.PublicKey, selfKey)
	if err := VerifyVerifiedChains([][]*x509.Certificate{{leaf2, selfCert, root}}); err == nil {
		t.Fatal("leaf outside the self-issued CA's permitted subtree must be rejected")
	}
}

func TestX509SelfIssuedLeafIsNotSkipped(t *testing.T) {
	rootKey := mustKey()
	rootTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "root"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
		PermittedDNSDomains:   []string{"example.test"},
	}
	root := mustCert(rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)

	// Leaf shares its subject naming with the issuer, so it is self-issued,
	// but it is the chain terminus and must not skip its name check.
	leafKey := mustKey()
	leafTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "root"},
		NotBefore:             baseTime(-1),
		NotAfter:              baseTime(24),
		BasicConstraintsValid: true,
		DNSNames:              []string{"forbidden.other.test"},
	}
	leaf := mustCert(leafTmpl, root, &leafKey.PublicKey, rootKey)
	if !isSelfIssued(leaf) {
		t.Fatal("test setup: leaf must be self-issued")
	}
	if err := VerifyVerifiedChains([][]*x509.Certificate{{leaf, root}}); err == nil {
		t.Fatal("self-issued leaf must never skip its own name check")
	}
}

func TestConstraintsAndNamesExtraction(t *testing.T) {
	pki := testPKI(t)
	permitted, _, err := ConstraintsFromCertificate(pki.root)
	if err != nil {
		t.Fatal(err)
	}
	if len(permitted) != 2 {
		t.Fatalf("root permitted DNS+IP = %d constraints, want 2", len(permitted))
	}

	interPermitted, interExcluded, err := ConstraintsFromCertificate(pki.inter)
	if err != nil || len(interPermitted) != 0 || len(interExcluded) != 1 {
		t.Fatalf("intermediate extraction: permitted=%d excluded=%d err=%v", len(interPermitted), len(interExcluded), err)
	}

	chain := pki.leaf(t, &x509.Certificate{
		DNSNames:    []string{"API.Example.TEST."},
		IPAddresses: []net.IP{net.ParseIP("10.0.0.1")},
	})
	names, err := NamesFromCertificate(chain[0])
	if err != nil {
		t.Fatal(err)
	}
	dns, ok := names[0].DNS()
	if !ok || dns != "api.example.test" {
		t.Fatalf("normalized DNS = %q, want api.example.test", dns)
	}
}
