package dataeng

import "testing"

func TestNormalizeURL(t *testing.T) {
	cases := []struct {
		raw  string
		base string
		want string
	}{
		{"HTTP://Example.COM:80/a/./b/../c?q=1#frag", "", "http://example.com/a/c?q=1"},
		{"https://Example.com:443", "", "https://example.com/"},
		{"/news/1", "https://Example.com/dir/sitemap.xml", "https://example.com/news/1"},
		{"https://example.com/%7euser", "", "https://example.com/~user"},
		{"https://example.com/a%2fb", "", "https://example.com/a%2Fb"},
		{"HTTP://[2001:DB8::1]:80/x", "", "http://[2001:db8::1]/x"},
		{"https://example.com/a/../", "", "https://example.com/"},
		{"https://example.com/path?", "", "https://example.com/path"},
		{"https://example.com/%41", "", "https://example.com/A"},
		{"https://example.com/a//b", "", "https://example.com/a//b"},
		{"https://example.com/a/%2E%2E/b", "", "https://example.com/b"},
		{"http://example.com:080/x", "", "http://example.com/x"},
		{"//cdn.example/x", "https://example.com/a", "https://cdn.example/x"},
		{"?p=2", "https://example.com/a?p=1", "https://example.com/a?p=2"},
	}
	for _, tc := range cases {
		var got string
		var err error
		if tc.base == "" {
			got, err = NormalizeURL(tc.raw)
		} else {
			got, err = NormalizeURLWithBase(tc.raw, tc.base)
		}
		if err != nil {
			t.Errorf("%q: %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestHostKey(t *testing.T) {
	if got := HostKey("HTTPS://Example.com:443/x"); got != "example.com" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeHost("Example.COM.:80"); got != "example.com" {
		t.Fatalf("NormalizeHost = %q", got)
	}
}

func TestNormalizeURLRejectsRelative(t *testing.T) {
	if _, err := NormalizeURL("/relative"); err == nil {
		t.Fatal("expected error")
	}
}

func TestFingerprint(t *testing.T) {
	a := ContentFingerprint([]byte("hello"))
	b := ContentFingerprint([]byte("hello"))
	c := ContentFingerprint([]byte("hello!"))
	if a != b || a == c {
		t.Fatalf("unexpected fingerprints: %s %s %s", a, b, c)
	}
	if len(a) != 64 {
		t.Fatalf("len = %d", len(a))
	}
}
