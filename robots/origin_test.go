package robots

import (
	"net/url"
	"testing"
)

func TestQ216ParseOriginCanonicalisation(t *testing.T) {
	tests := []struct {
		input  string
		scheme string
		host   string
		port   string
	}{
		{"HTTPS://Example.COM/path?q=1", "https", "example.com", "443"},
		{"http://example.com:8080/a", "http", "example.com", "8080"},
		{"https://example.com./", "https", "example.com", "443"},
		{"https://[2001:DB8::1]:8443/robots.txt", "https", "2001:db8::1", "8443"},
	}
	for _, test := range tests {
		origin, err := ParseOrigin(test.input)
		if err != nil {
			t.Fatalf("ParseOrigin(%q): %v", test.input, err)
		}
		if origin.Scheme != test.scheme || origin.Host != test.host || origin.Port != test.port {
			t.Errorf("ParseOrigin(%q) = %+v", test.input, origin)
		}
	}
}

func TestQ216OriginKeyAndURL(t *testing.T) {
	a, err := NewOrigin("https", "Example.COM.", "443")
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseOrigin("https://example.com/")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("origins differ: %+v %+v", a, b)
	}
	if a.Key() != "https://example.com:443" {
		t.Fatalf("Key = %q", a.Key())
	}
	if a.RobotsURL() != "https://example.com:443/robots.txt" {
		t.Fatalf("RobotsURL = %q", a.RobotsURL())
	}
}

func TestQ216OriginFromURL(t *testing.T) {
	parsed, err := url.Parse("http://example.com:80/x")
	if err != nil {
		t.Fatal(err)
	}
	origin, err := OriginFromURL(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if origin.String() != "http://example.com:80" {
		t.Fatalf("origin = %s", origin)
	}
}

func TestQ216InvalidOrigins(t *testing.T) {
	values := []string{
		"", "example.com", "http://", "http://example.com:0",
		"http://example.com:99999", "custom://example.com",
		"http://bad host/", "1http://example.com",
	}
	for _, value := range values {
		if _, err := ParseOrigin(value); err == nil {
			t.Errorf("ParseOrigin(%q) unexpectedly succeeded", value)
		}
	}
	if _, err := NewOrigin("https", "bad/path", "443"); err == nil {
		t.Error("host containing a path separator was accepted")
	}
}
