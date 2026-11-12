package dataeng

// DefaultMaxHeaderCards is the default limit on physical cards before and
// including END.
const DefaultMaxHeaderCards = 1024

// DefaultMaxOutputPixels is the default limit on samples returned by one
// ReadRect call.
const DefaultMaxOutputPixels int64 = 1 << 20

// Options controls the parser's resource limits. A zero field selects its
// corresponding default.
type Options struct {
	MaxHeaderCards  int
	MaxOutputPixels int64
}

// Option changes one field of Options.
type Option func(*Options)

// DefaultOptions returns the package defaults.
func DefaultOptions() Options {
	return Options{
		MaxHeaderCards:  DefaultMaxHeaderCards,
		MaxOutputPixels: DefaultMaxOutputPixels,
	}
}

// WithMaxHeaderCards sets the maximum number of physical header cards,
// including END.
func WithMaxHeaderCards(n int) Option {
	return func(o *Options) {
		o.MaxHeaderCards = n
	}
}

// WithMaxOutputPixels sets the maximum number of samples one ReadRect call
// may return.
func WithMaxOutputPixels(n int64) Option {
	return func(o *Options) {
		o.MaxOutputPixels = n
	}
}

func normalizeOptions(o Options) Options {
	if o.MaxHeaderCards == 0 {
		o.MaxHeaderCards = DefaultMaxHeaderCards
	}
	if o.MaxOutputPixels == 0 {
		o.MaxOutputPixels = DefaultMaxOutputPixels
	}
	return o
}
