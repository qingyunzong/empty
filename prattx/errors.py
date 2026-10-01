"""Parse error type for prattx."""


class ParseError(Exception):
    """Raised on any syntax error.

    Attributes:
        got: what was found (token text, or "EOF").
        expected: what was expected (human readable).
        span: (start, end) character offsets into the source.
    """

    def __init__(self, got, expected, span):
        self.got = got
        self.expected = expected
        self.span = (int(span[0]), int(span[1]))
        super().__init__(self._format())

    def _format(self):
        return (
            "parse error: expected %s, got %r at %d..%d"
            % (self.expected, self.got, self.span[0], self.span[1])
        )

    def to_dict(self):
        return {
            "type": "parse_error",
            "got": self.got,
            "expected": self.expected,
            "span": [self.span[0], self.span[1]],
            "message": str(self),
        }
