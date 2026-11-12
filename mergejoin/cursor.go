package mergejoin

import (
	"context"
	"io"
)

// cursor pages through one Stream, exposing a one-row lookahead so the
// merge can compare the smallest pending keys of the two sides. Ordering is
// validated for every fetched row in peek, including rows whose key is
// skipped because the other side has no match.
type cursor[P any] struct {
	stream Stream[P]
	side   Side

	page []Row[P]
	pos  int
	head *Row[P]

	lastKey   int64
	hasLast   bool
	exhausted bool
}

func newCursor[P any](stream Stream[P], side Side) *cursor[P] {
	return &cursor[P]{stream: stream, side: side}
}

// peek returns the next row without consuming it, or io.EOF at the end.
func (c *cursor[P]) peek(ctx context.Context) (*Row[P], error) {
	if c.head != nil {
		return c.head, nil
	}
	if c.exhausted {
		return nil, io.EOF
	}

	row, err := c.advance(ctx)
	if err != nil {
		return nil, err
	}
	if c.hasLast && row.Key < c.lastKey {
		return nil, ErrUnsorted
	}
	c.lastKey = row.Key
	c.hasLast = true
	c.head = &row
	return c.head, nil
}

// consume removes the lookahead row.
func (c *cursor[P]) consume() {
	c.head = nil
}

// advance pulls the next row from the current page, fetching further pages
// as needed.
func (c *cursor[P]) advance(ctx context.Context) (Row[P], error) {
	for c.pos >= len(c.page) {
		page, err := c.stream.NextPage(ctx)
		if err != nil {
			if err == io.EOF {
				c.exhausted = true
			}
			return Row[P]{}, err
		}
		c.page = page
		c.pos = 0
		if len(page) == 0 {
			continue
		}
	}

	row := c.page[c.pos]
	c.pos++
	return row, nil
}

// drainGroup consumes every consecutive row whose key equals key and feeds
// it to add.
func (c *cursor[P]) drainGroup(ctx context.Context, key int64, add func(context.Context, Row[P]) error) error {
	for {
		row, err := c.peek(ctx)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if row.Key != key {
			return nil
		}
		c.consume()
		if err := add(ctx, *row); err != nil {
			return err
		}
	}
}

// skipGroup drops every remaining row of the current key without staging it.
func (c *cursor[P]) skipGroup(ctx context.Context, key int64) error {
	return c.drainGroup(ctx, key, func(context.Context, Row[P]) error {
		return nil
	})
}
