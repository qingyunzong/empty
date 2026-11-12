package dataeng

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

const sampleRobots = `
# comment line
User-agent: other
Disallow: /other

User-agent: mybot
Disallow: /private
Allow: /private/public

User-agent: *
Disallow: /star
`

func staticFetch(text string) FetchFunc {
	return func(context.Context, string) (string, error) { return text, nil }
}

func TestBasicMatching(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1000, 0)}
	p := NewPolicy("mybot", time.Minute, clock.Now, staticFetch(sampleRobots))
	ctx := context.Background()

	cases := []struct {
		url  string
		want bool
	}{
		{"http://example.com/", true},
		{"http://example.com/private", false},
		{"http://example.com/private/public", true},
		{"http://example.com/star", true}, // mybot 组优先于星号组
		{"http://example.com/other", true},
	}
	for _, tc := range cases {
		got, err := p.Allowed(ctx, tc.url)
		if err != nil {
			t.Fatalf("Allowed(%q) error: %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("Allowed(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestRefreshRace(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1000, 0)}
	var calls atomic.Int32
	release := make(chan struct{})
	fetch := func(context.Context, string) (string, error) {
		calls.Add(1)
		<-release
		return "User-agent: *\nDisallow: /x\n", nil
	}
	p := NewPolicy("mybot", time.Minute, clock.Now, fetch)

	const n = 16
	var wg sync.WaitGroup
	results := make([]bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ok, err := p.Allowed(context.Background(), "http://example.com/x")
			if err != nil {
				t.Errorf("Allowed error: %v", err)
			}
			results[i] = ok
		}(i)
	}
	// 等所有 goroutine 进入等待后放行共享获取。
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("fetch called %d times, want 1", got)
	}
	for i, ok := range results {
		if ok {
			t.Errorf("waiter %d got allowed, want disallowed", i)
		}
	}

	// 缓存命中，不再获取。
	if _, err := p.Allowed(context.Background(), "http://example.com/x"); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("fetch called %d times after cache hit, want 1", got)
	}

	// 恰到期须刷新。
	clock.Advance(time.Minute)
	if _, err := p.Allowed(context.Background(), "http://example.com/x"); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("fetch called %d times at expiry, want 2", got)
	}
}

func TestWaiterCancelDoesNotCancelSharedFetch(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1000, 0)}
	release := make(chan struct{})
	fetch := func(ctx context.Context, _ string) (string, error) {
		select {
		case <-release:
			return "User-agent: *\nDisallow: /x\n", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	p := NewPolicy("mybot", time.Minute, clock.Now, fetch)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := p.Allowed(ctx, "http://example.com/x")
		errCh <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter err = %v, want context.Canceled", err)
	}

	// 共享获取不受取消影响，完成后结果被缓存。
	close(release)
	time.Sleep(20 * time.Millisecond)
	ok, err := p.Allowed(context.Background(), "http://example.com/x")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("got allowed, want disallowed from cached shared fetch")
	}
}

func TestSameLengthGroupsMerge(t *testing.T) {
	text := `
User-agent: alpha
Disallow: /a

User-agent: BETA1
Disallow: /b

User-agent: gamma-longer
Disallow: /g
`
	// 产品标识含 alpha(5) 与 beta1(5)，同长度组合并；gamma-longer 不匹配。
	p := NewPolicy("xx-alpha-yy-beta1-zz", time.Minute, (&fakeClock{now: time.Unix(1000, 0)}).Now, staticFetch(text))
	ctx := context.Background()

	cases := []struct {
		url  string
		want bool
	}{
		{"http://example.com/a", false},
		{"http://example.com/b", false},
		{"http://example.com/g", true},
	}
	for _, tc := range cases {
		got, err := p.Allowed(ctx, tc.url)
		if err != nil {
			t.Fatalf("Allowed(%q) error: %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("Allowed(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestStarGroupFallback(t *testing.T) {
	p := NewPolicy("unknownbot", time.Minute, (&fakeClock{now: time.Unix(1000, 0)}).Now, staticFetch(sampleRobots))
	ok, err := p.Allowed(context.Background(), "http://example.com/star")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("star group fallback: got allowed, want disallowed")
	}
}

func TestEncodedPath(t *testing.T) {
	text := `
User-agent: *
Disallow: /a%2Fb
Disallow: /literal%2Astar
Allow: /a%2Fb/ok
`
	p := NewPolicy("mybot", time.Minute, (&fakeClock{now: time.Unix(1000, 0)}).Now, staticFetch(text))
	ctx := context.Background()

	cases := []struct {
		url  string
		want bool
	}{
		{"http://example.com/a%2Fb", false}, // 按原始字节比较，不解码百分号
		{"http://example.com/a%2Fb/ok", true},
		{"http://example.com/a/b", true}, // 解码后的路径不匹配
		{"http://example.com/literal%2Astar", false},
		{"http://example.com/literal*star", true}, // 规则中的 %2A 不是星号通配
	}
	for _, tc := range cases {
		got, err := p.Allowed(ctx, tc.url)
		if err != nil {
			t.Fatalf("Allowed(%q) error: %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("Allowed(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestQueryAndAnchor(t *testing.T) {
	text := `
User-agent: *
Disallow: /search?*q=*
Disallow: /exact$
Disallow: /feed?q=$
`
	p := NewPolicy("mybot", time.Minute, (&fakeClock{now: time.Unix(1000, 0)}).Now, staticFetch(text))
	ctx := context.Background()

	cases := []struct {
		url  string
		want bool
	}{
		{"http://example.com/search?q=x", false}, // 查询串参与比较
		{"http://example.com/search?q=x&p=1", false},
		{"http://example.com/search?p=1", true},
		{"http://example.com/search", true},
		{"http://example.com/exact", false},
		{"http://example.com/exact/more", true}, // 末尾美元符锚定
		{"http://example.com/feed?q=", false},   // 锚定末尾的查询串
		{"http://example.com/feed?q=x", true},
	}
	for _, tc := range cases {
		got, err := p.Allowed(ctx, tc.url)
		if err != nil {
			t.Fatalf("Allowed(%q) error: %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("Allowed(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestFailureRecovery(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1000, 0)}
	var calls atomic.Int32
	fail := true
	fetch := func(context.Context, string) (string, error) {
		calls.Add(1)
		if fail {
			return "", errors.New("boom")
		}
		return "User-agent: *\nDisallow: /x\n", nil
	}
	p := NewPolicy("mybot", time.Minute, clock.Now, fetch)
	ctx := context.Background()

	// 并发等待者都收到不可判定。
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = p.Allowed(ctx, "http://example.com/x")
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if !errors.Is(err, ErrUndecidable) {
			t.Errorf("waiter %d err = %v, want ErrUndecidable", i, err)
		}
	}
	firstCalls := calls.Load()

	// 失败不缓存：后续请求重新获取。
	if _, err := p.Allowed(ctx, "http://example.com/x"); !errors.Is(err, ErrUndecidable) {
		t.Fatalf("err = %v, want ErrUndecidable", err)
	}
	if calls.Load() <= firstCalls {
		t.Fatal("failure was cached; expected a new fetch")
	}

	// 恢复后可正常判定并缓存。
	fail = false
	ok, err := p.Allowed(ctx, "http://example.com/x")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("got allowed, want disallowed after recovery")
	}
	before := calls.Load()
	if _, err := p.Allowed(ctx, "http://example.com/x"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != before {
		t.Fatal("successful result was not cached")
	}
}

func TestCacheKeyedByOrigin(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1000, 0)}
	var mu sync.Mutex
	fetched := map[string]int{}
	fetch := func(_ context.Context, robotsURL string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		fetched[robotsURL]++
		return "User-agent: *\nDisallow: /x\n", nil
	}
	p := NewPolicy("mybot", time.Minute, clock.Now, fetch)
	ctx := context.Background()

	for _, u := range []string{
		"http://example.com/x",
		"http://example.com/x",    // 命中缓存
		"http://example.com:80/y", // 默认端口与显式 80 同源
		"http://example.com:8080/x",
		"https://example.com/x",
		"http://other.com/x",
	} {
		if _, err := p.Allowed(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string]int{
		"http://example.com/robots.txt":      1,
		"http://example.com:8080/robots.txt": 1,
		"https://example.com/robots.txt":     1,
		"http://other.com/robots.txt":        1,
	}
	if len(fetched) != len(want) {
		t.Fatalf("fetched = %v, want %v", fetched, want)
	}
	for u, n := range want {
		if fetched[u] != n {
			t.Errorf("fetch %q = %d times, want %d", u, fetched[u], n)
		}
	}
}
