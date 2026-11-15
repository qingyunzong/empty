package robots

import (
	"strings"
	"testing"
	"time"
)

func TestQ216ParseAndEvaluateUserAgentGroups(t *testing.T) {
	document := `
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 1.5

User-agent: ExampleBot
Disallow: /tmp
Allow: /tmp/ok
Crawl-delay: 2
`
	rules, err := Parse(strings.NewReader(document))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	generic := rules.For("SomeCrawler")
	if !generic.Matched || generic.UserAgent != "*" {
		t.Fatalf("generic group = %+v", generic)
	}
	if generic.CrawlDelay != 1500*time.Millisecond {
		t.Fatalf("generic crawl delay = %v", generic.CrawlDelay)
	}

	tests := []struct {
		name      string
		userAgent string
		target    string
		want      bool
		wantMatch bool
		wantDelay time.Duration
	}{
		{"generic disallow", "SomeCrawler", "/private/secret", false, true, 1500 * time.Millisecond},
		{"generic allow overrides prefix", "SomeCrawler", "/private/public/article", true, true, 1500 * time.Millisecond},
		{"path prefix applies", "SomeCrawler", "/private2", false, true, 1500 * time.Millisecond},
		{"default allow", "SomeCrawler", "/public", true, false, 1500 * time.Millisecond},
		{"specific group replaces wildcard", "ExampleBot", "/private/secret", true, false, 2 * time.Second},
		{"specific disallow", "ExampleBot", "/tmp/file", false, true, 2 * time.Second},
		{"specific allow", "ExampleBot", "/tmp/ok/file", true, true, 2 * time.Second},
		{"user agent is case insensitive", "examplebot/1.0", "/tmp", false, true, 2 * time.Second},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := rules.Evaluate(test.userAgent, test.target)
			if decision.Allowed != test.want {
				t.Fatalf("Allowed = %v, want %v (decision %+v)", decision.Allowed, test.want, decision)
			}
			if decision.Matched != test.wantMatch {
				t.Fatalf("Matched = %v, want %v", decision.Matched, test.wantMatch)
			}
			if decision.CrawlDelay != test.wantDelay {
				t.Fatalf("CrawlDelay = %v, want %v", decision.CrawlDelay, test.wantDelay)
			}
		})
	}
}

func TestQ216WildcardAndAnchor(t *testing.T) {
	rules, err := Parse(strings.NewReader(`
User-agent: *
Disallow: /*.pdf$
Allow: /public/*.pdf$
Disallow: /search*results
`))
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		target string
		want   bool
	}{
		{"/doc.pdf", false},
		{"/doc.pdf?download=1", true},
		{"/public/doc.pdf", true},
		{"/public/doc.pdf?download=1", true},
		{"/search?q=results", false},
		{"/search/x/results", false},
		{"/search", true},
	}
	for _, test := range tests {
		if got := rules.Allowed("*", test.target); got != test.want {
			t.Errorf("Allowed(%q) = %v, want %v", test.target, got, test.want)
		}
	}
}

func TestQ216AllowWinsTie(t *testing.T) {
	rules, err := Parse(strings.NewReader(`
User-agent: *
Disallow: /same
Allow: /same
`))
	if err != nil {
		t.Fatal(err)
	}
	if !rules.Allowed("*", "/same") {
		t.Fatal("equal-length Allow should win")
	}
}

func TestQ216EmptyDisallowAllowsEverything(t *testing.T) {
	rules, err := Parse(strings.NewReader("User-agent: *\nDisallow:\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !rules.Allowed("*", "/anything") {
		t.Fatal("empty Disallow should impose no restriction")
	}
	if got := rules.CrawlDelayFor("*"); got != 0 {
		t.Fatalf("crawl delay = %v", got)
	}
}

func TestQ216MultipleGroupsForSameAgentMerge(t *testing.T) {
	rules, err := Parse(strings.NewReader(`
User-agent: MergeBot
Disallow: /a

User-agent: MergeBot
Disallow: /b
Crawl-delay: 3
`))
	if err != nil {
		t.Fatal(err)
	}
	agent := rules.For("MergeBot")
	if len(agent.Rules) != 2 {
		t.Fatalf("merged rules = %+v", agent.Rules)
	}
	if agent.CrawlDelay != 3*time.Second {
		t.Fatalf("crawl delay = %v", agent.CrawlDelay)
	}
	if rules.Allowed("MergeBot", "/a") || rules.Allowed("MergeBot", "/b") {
		t.Fatal("both merged disallows should apply")
	}
}

func TestQ216ParsingToleratesBOMCommentsCRLFAndBadDelay(t *testing.T) {
	rules, err := Parse(strings.NewReader("\ufeffUser-agent: *\r\n" +
		"Disallow: /x # comment\r\n" +
		"Crawl-delay: not-a-number\r\n" +
		"Unknown: ignored\r\n" +
		"Sitemap: https://example.com/sitemap.xml\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if rules.Allowed("*", "/x") {
		t.Fatal("/x should be disallowed")
	}
	if got := rules.CrawlDelayFor("*"); got != 0 {
		t.Fatalf("invalid crawl delay was accepted: %v", got)
	}
	if len(rules.Sitemaps) != 1 || rules.Sitemaps[0] != "https://example.com/sitemap.xml" {
		t.Fatalf("sitemaps = %+v", rules.Sitemaps)
	}
}

func TestQ216DollarAnchor(t *testing.T) {
	rules, err := Parse(strings.NewReader("User-agent: *\nDisallow: /fish$\n"))
	if err != nil {
		t.Fatal(err)
	}
	if rules.Allowed("*", "/fish") {
		t.Fatal("/fish should match the anchored rule")
	}
	if !rules.Allowed("*", "/fish/") {
		t.Fatal("/fish/ should not match the anchored rule")
	}
}

func TestQ216RulesCloneIsIndependent(t *testing.T) {
	rules, err := Parse(strings.NewReader("User-agent: *\nDisallow: /x\n"))
	if err != nil {
		t.Fatal(err)
	}
	clone := rules.Clone()
	clone.Groups[0].Rules[0].Pattern = "/y"
	if rules.Allowed("*", "/x") {
		t.Fatal("mutating a clone changed the original")
	}
	if clone.Allowed("*", "/y") {
		t.Fatal("clone mutation did not take effect")
	}
}
