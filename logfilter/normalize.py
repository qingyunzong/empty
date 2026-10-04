"""Versioned text normalization rules.

Normalization is applied to document tokens and to literal pattern
characters.  The rule set is fixed; every index records the version it
was built with and refuses to operate under a different version.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

DEFAULT_VERSION = "nfc-casefold-v1"


def _nfc_casefold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def _identity(text: str) -> str:
    return text


NORMALIZERS = {
    "nfc-casefold-v1": _nfc_casefold,
    "identity-v0": _identity,
}


class UnknownNormalizationVersion(ValueError):
    pass


@dataclass(frozen=True)
class NormalizationRules:
    """A fixed, versioned normalization rule set."""

    version: str = DEFAULT_VERSION

    def normalize(self, text: str) -> str:
        try:
            fn = NORMALIZERS[self.version]
        except KeyError:
            raise UnknownNormalizationVersion(
                f"unknown normalization version: {self.version!r}"
            ) from None
        return fn(text)
