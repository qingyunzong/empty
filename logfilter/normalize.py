"""Versioned, fixed text normalization rules.

Matching is performed on Unicode code points after normalization.
The rule set is fixed; any change to the rules MUST ship under a new
version string so that existing indexes can detect the mismatch.
"""

import unicodedata

CURRENT_NORMALIZATION_VERSION = "nfc-casefold-v1"


def _nfc_casefold(text):
    # NFC composes canonically-equivalent sequences (e.g. e + U+0301 -> é),
    # casefold() gives aggressive Unicode-aware case insensitivity.
    return unicodedata.normalize("NFC", text).casefold()


_RULES = {
    "nfc-casefold-v1": _nfc_casefold,
}


def normalize(text, version=CURRENT_NORMALIZATION_VERSION):
    try:
        rule = _RULES[version]
    except KeyError:
        raise ValueError(f"unknown normalization version: {version!r}") from None
    return rule(text)
