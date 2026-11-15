package robots

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// ErrParse indicates that a robots.txt stream could not be consumed.
var ErrParse = errors.New("robots: parse error")

const maxRobotsLine = 64 * 1024

// Parse reads a robots.txt document. Unknown directives and malformed
// Crawl-delay values are ignored; an I/O or over-long-line error is returned.
func Parse(r io.Reader) (*Rules, error) {
	if r == nil {
		return nil, fmt.Errorf("%w: nil reader", ErrParse)
	}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), maxRobotsLine)

	var (
		groups   []Group
		sitemaps []string
		agents   []string
		rules    []Rule
		delay    time.Duration
		started  bool
		first    = true
	)

	flush := func() {
		if len(agents) == 0 {
			agents = nil
			rules = nil
			delay = 0
			started = false
			return
		}
		groups = append(groups, Group{
			UserAgents: agents,
			Rules:      rules,
			CrawlDelay: delay,
		})
		agents = nil
		rules = nil
		delay = 0
		started = false
	}

	for scanner.Scan() {
		line := scanner.Text()
		if first {
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		if index := strings.IndexByte(line, '#'); index >= 0 {
			line = line[:index]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)

		switch key {
		case "user-agent":
			if started {
				flush()
			}
			if value != "" {
				agents = append(agents, strings.ToLower(value))
			}
		case "allow", "disallow":
			if len(agents) == 0 {
				continue
			}
			started = true
			if value == "" {
				// An empty Disallow imposes no restriction. An empty Allow is
				// a no-op. Both still separate this group from the next one.
				continue
			}
			rules = append(rules, Rule{Allow: key == "allow", Pattern: value})
		case "crawl-delay":
			if len(agents) == 0 {
				continue
			}
			started = true
			if parsed, valid := parseCrawlDelay(value); valid && parsed > delay {
				delay = parsed
			}
		case "sitemap":
			if value != "" {
				sitemaps = append(sitemaps, value)
			}
		}
	}
	flush()

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrParse, err)
	}
	return &Rules{Groups: groups, Sitemaps: sitemaps}, nil
}

// ParseBytes parses a robots.txt byte slice.
func ParseBytes(data []byte) (*Rules, error) {
	return Parse(bytes.NewReader(data))
}

func parseCrawlDelay(value string) (time.Duration, bool) {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 {
		return 0, false
	}
	nanos := seconds * float64(time.Second)
	if nanos > float64(math.MaxInt64) {
		return 0, false
	}
	return time.Duration(nanos), true
}
