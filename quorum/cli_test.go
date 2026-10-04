package quorum

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runCLI(t *testing.T, args []string, stdin string) (string, error) {
	t.Helper()
	var out, errBuf bytes.Buffer
	err := RunCLI(args, strings.NewReader(stdin), &out, &errBuf)
	if err != nil {
		t.Logf("stderr: %s", errBuf.String())
	}
	return out.String(), err
}

func inputJSON(t *testing.T, in *Input) string {
	t.Helper()
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCLIQuorumAndVerify(t *testing.T) {
	in := inputJSON(t, exampleInput())
	out, err := runCLI(t, []string{"quorum"}, in)
	if err != nil {
		t.Fatal(err)
	}
	var cert QuorumCertificate
	if err := json.Unmarshal([]byte(out), &cert); err != nil {
		t.Fatalf("decoding CLI output: %v", err)
	}
	if cert.Status != "optimal" || cert.Cost != 7 {
		t.Fatalf("unexpected certificate: %s", out)
	}

	certFile := filepath.Join(t.TempDir(), "cert.json")
	if err := os.WriteFile(certFile, []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
	vout, err := runCLI(t, []string{"verify-quorum", "-cert", certFile}, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(vout, `"valid": true`) {
		t.Fatalf("verify output = %q", vout)
	}
}

func TestCLIPairAndVerify(t *testing.T) {
	in := inputJSON(t, pairExampleInput())
	out, err := runCLI(t, []string{"pair"}, in)
	if err != nil {
		t.Fatal(err)
	}
	var cert PairCertificate
	if err := json.Unmarshal([]byte(out), &cert); err != nil {
		t.Fatalf("decoding CLI output: %v", err)
	}
	if cert.Status != "optimal" || cert.Cost != 27 {
		t.Fatalf("unexpected certificate: %s", out)
	}

	certFile := filepath.Join(t.TempDir(), "pair.json")
	if err := os.WriteFile(certFile, []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
	vout, err := runCLI(t, []string{"verify-pair", "-cert", certFile}, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(vout, `"valid": true`) {
		t.Fatalf("verify output = %q", vout)
	}
}

func TestCLIVerifyRejectsBadCertificate(t *testing.T) {
	in := inputJSON(t, exampleInput())
	certFile := filepath.Join(t.TempDir(), "cert.json")
	if err := os.WriteFile(certFile, []byte(`{"status":"optimal","members":["a"],"cost":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runCLI(t, []string{"verify-quorum", "-cert", certFile}, in); err == nil {
		t.Fatal("invalid certificate accepted")
	}
}

func TestCLIErrors(t *testing.T) {
	if _, err := runCLI(t, nil, ""); err == nil {
		t.Fatal("missing command accepted")
	}
	if _, err := runCLI(t, []string{"bogus"}, ""); err == nil {
		t.Fatal("unknown command accepted")
	}
	if _, err := runCLI(t, []string{"quorum"}, "not json"); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	if _, err := runCLI(t, []string{"verify-quorum"}, "{}"); err == nil {
		t.Fatal("verify without -cert accepted")
	}
}
