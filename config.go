package dataeng

import "time"

const (
	defaultMaxPending      = 4096
	defaultMaxPendingBytes = 16 << 20
)

// Config controls a Store. Zero values select safe defaults.
type Config struct {
	// MaxPending bounds the number of data sets waiting for templates.
	// A negative value disables the count bound.
	MaxPending int

	// MaxPendingDataSets and Capacity are accepted aliases for MaxPending;
	// MaxPending wins when more than one is set.
	MaxPendingDataSets int
	Capacity           int

	// MaxPendingBytes bounds the raw bytes retained for pending data sets.
	// A negative value disables the byte bound.
	MaxPendingBytes int

	// TemplateTTL expires templates that have not been refreshed. Zero means
	// no time-based expiry. An expired template is treated exactly like a
	// missing template: data is queued, never decoded by guessing.
	TemplateTTL time.Duration
	// OptionTemplateTTL overrides TemplateTTL for option templates when
	// non-zero. Option templates are otherwise managed independently.
	OptionTemplateTTL time.Duration
	// PendingTTL bounds how long a data set may wait for a template. Zero
	// means no time-based expiry.
	PendingTTL time.Duration

	// DropOldest changes overflow behavior from rejecting the newest data set
	// to evicting the oldest queued data set.
	DropOldest bool

	// Clock supplies receive and expiry timestamps. It defaults to time.Now.
	Clock func() time.Time
}

// Option mutates a Config. Options are accepted by NewStore.
type Option func(*Config)

// WithMaxPending sets the maximum number of queued data sets.
func WithMaxPending(n int) Option {
	return func(c *Config) { c.MaxPending = n }
}

// WithMaxPendingBytes sets the maximum raw bytes retained in the waiting area.
func WithMaxPendingBytes(n int) Option {
	return func(c *Config) { c.MaxPendingBytes = n }
}

// WithTemplateTTL sets the template idle lifetime.
func WithTemplateTTL(d time.Duration) Option {
	return func(c *Config) { c.TemplateTTL = d }
}

// WithOptionTemplateTTL sets an independent options-template lifetime.
func WithOptionTemplateTTL(d time.Duration) Option {
	return func(c *Config) { c.OptionTemplateTTL = d }
}

// WithPendingTTL sets how long data sets may wait for a template.
func WithPendingTTL(d time.Duration) Option {
	return func(c *Config) { c.PendingTTL = d }
}

// WithDropOldest selects oldest-first eviction on pending overflow.
func WithDropOldest(drop bool) Option {
	return func(c *Config) { c.DropOldest = drop }
}

// WithClock sets the clock used for receive and expiry timestamps.
func WithClock(clock func() time.Time) Option {
	return func(c *Config) { c.Clock = clock }
}

func newConfig(settings []any) Config {
	var cfg Config
	for _, setting := range settings {
		switch x := setting.(type) {
		case Config:
			cfg = x
		case *Config:
			if x != nil {
				cfg = *x
			}
		case Option:
			if x != nil {
				x(&cfg)
			}
		case func(*Config):
			if x != nil {
				x(&cfg)
			}
		case nil:
		default:
			panic("dataeng: unsupported NewStore option type")
		}
	}
	cfg.normalize()
	return cfg
}

func (c *Config) normalize() {
	if c.MaxPending == 0 {
		c.MaxPending = c.MaxPendingDataSets
	}
	if c.MaxPending == 0 {
		c.MaxPending = c.Capacity
	}
	if c.MaxPending == 0 {
		c.MaxPending = defaultMaxPending
	}
	if c.MaxPendingBytes == 0 {
		c.MaxPendingBytes = defaultMaxPendingBytes
	}
	if c.Clock == nil {
		c.Clock = time.Now
	}
}

func (c Config) templateTTL(kind TemplateKind) time.Duration {
	if kind == TemplateOptions && c.OptionTemplateTTL != 0 {
		return c.OptionTemplateTTL
	}
	return c.TemplateTTL
}
