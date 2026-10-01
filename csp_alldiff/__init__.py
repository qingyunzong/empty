"""csp_alldiff: AllDifferent global constraint propagation over integer finite domains."""

from .alldiff import DomainError, propagate, validate_domains

__all__ = ["DomainError", "propagate", "validate_domains"]
