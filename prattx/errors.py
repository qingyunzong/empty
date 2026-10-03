"""Parse error type for prattx."""


class ParseError(Exception):
    """Raised for any lexical or syntactic error.

    Attributes:
        got: the offending token text (or ``<eof>``).
        expected: description of what was expected.
        span: ``(start, end)`` character offsets into the source.
    """

    def __init__(self, got, expected, span):
        self.got = got
        self.expected = expected
        self.span = (int(span[0]), int(span[1]))
        super().__init__(
            "parse error: expected %s, got %s at %d:%d"
            % (self.expected, self.got, self.span[0], self.span[1])
        )

    def to_dict(self):
        return {
            "message": str(self),
            "got": self.got,
            "expected": self.expected,
            "span": [self.span[0], self.span[1]],
        }
