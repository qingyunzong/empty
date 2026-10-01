"""Exact-rational JSON encoding for numeric values.

Numbers are carried internally as fractions.Fraction so that sums and
medians are exact.  The JSON wire form is:
  null            -> None
  7               -> Fraction(7)
  1.5 / "1.5"     -> Fraction(3, 2)   (parsed via str, no binary error)
  "3/2"           -> Fraction(3, 2)
  {"num": 3, "den": 2} -> Fraction(3, 2)
"""

from fractions import Fraction


def num_from_json(data):
    if data is None:
        return None
    if isinstance(data, bool):
        raise ValueError("boolean is not a number")
    if isinstance(data, int):
        return Fraction(data)
    if isinstance(data, float):
        return Fraction(str(data))
    if isinstance(data, str):
        return Fraction(data)
    if isinstance(data, dict):
        return Fraction(int(data["num"]), int(data["den"]))
    raise ValueError(f"unsupported number: {data!r}")


def num_to_json(value):
    if value is None:
        return None
    if not isinstance(value, Fraction):
        value = Fraction(value)
    if value.denominator == 1:
        return value.numerator
    return {"num": value.numerator, "den": value.denominator}
