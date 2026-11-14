#!/usr/bin/env python3
"""Generate compact C++ tables for the dataeng Unicode normalizer.

Primary Unicode data comes from Python's unicodedata module, whose bundled
Unicode version is recorded in the generated output.  Script and
Default_Ignorable_Code_Point data comes from the ``regenerate-unicode-properties``
package (the copy normally shipped with Node.js).  Script data newer than the
normalization tables is filtered to code points assigned in the normalization
Unicode version, so the generated library presents one consistent version.

Usage:
    python3 tools/generate_unicode_data.py [--node-root PATH] [--output FILE]
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

SURROGATE_FIRST = 0xD800
SURROGATE_LAST = 0xDFFF
MAX_CP = 0x10FFFF


def is_scalar(cp: int) -> bool:
    return 0 <= cp <= MAX_CP and not (SURROGATE_FIRST <= cp <= SURROGATE_LAST)


def is_assigned(cp: int) -> bool:
    return is_scalar(cp) and unicodedata.category(chr(cp)) != "Cn"


def parse_property_file(path: Path) -> list[tuple[int, int]]:
    """Parse the small regenerate-unicode-properties source format."""
    text = path.read_text(encoding="utf-8")
    ranges: list[tuple[int, int]] = []

    constructor = re.search(r"require\(['\"]regenerate['\"]\)\s*\(([^)]*)\)", text)
    if constructor:
        for token in re.findall(r"0x[0-9A-Fa-f]+", constructor.group(1)):
            value = int(token, 16)
            ranges.append((value, value))
    for first, last in re.findall(
        r"addRange\(\s*(0x[0-9A-Fa-f]+)\s*,\s*(0x[0-9A-Fa-f]+)\s*\)", text
    ):
        ranges.append((int(first, 16), int(last, 16)))
    ranges.sort()
    return ranges


def expand_intervals(ranges: list[tuple[int, int]], predicate) -> list[int]:
    values: set[int] = set()
    for first, last in ranges:
        for cp in range(first, min(last, MAX_CP) + 1):
            if predicate(cp):
                values.add(cp)
    return sorted(values)


def compress(values: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for cp in values:
        if out and cp == out[-1][1] + 1:
            out[-1] = (out[-1][0], cp)
        else:
            out.append((cp, cp))
    return out


def compress_ccc_ranges() -> list[tuple[int, int, int]]:
    out: list[tuple[int, int, int]] = []
    run_start = None
    run_ccc = 0
    for cp in range(MAX_CP + 1):
        ccc = unicodedata.combining(chr(cp)) if is_scalar(cp) else 0
        if run_start is not None and ccc == run_ccc:
            continue
        if run_start is not None and run_ccc != 0:
            out.append((run_start, cp - 1, run_ccc))
        run_start = cp
        run_ccc = ccc
    if run_start is not None and run_ccc != 0:
        out.append((run_start, MAX_CP, run_ccc))
    return out


def build_decompositions():
    entries: list[tuple[int, int, int]] = []
    data: list[int] = []
    for cp in range(MAX_CP + 1):
        if not is_scalar(cp):
            continue
        ch = chr(cp)
        mapping = unicodedata.normalize("NFKD", ch)
        if mapping == ch:
            continue
        values = [ord(c) for c in mapping]
        entries.append((cp, len(data), len(values)))
        data.extend(values)
    return entries, data


def build_casefolds():
    entries: list[tuple[int, int, int]] = []
    data: list[int] = []
    for cp in range(MAX_CP + 1):
        if not is_scalar(cp):
            continue
        ch = chr(cp)
        mapping = ch.casefold()
        if mapping == ch:
            continue
        values = [ord(c) for c in mapping]
        entries.append((cp, len(data), len(values)))
        data.extend(values)
    return entries, data


def build_compositions():
    pairs: dict[tuple[int, int], int] = {}
    for cp in range(MAX_CP + 1):
        if not is_scalar(cp):
            continue
        decomposition = unicodedata.decomposition(chr(cp))
        if not decomposition or decomposition.startswith("<"):
            continue
        values = [int(part, 16) for part in decomposition.split()]
        if len(values) != 2:
            continue
        first, second = values
        if not (is_scalar(first) and is_scalar(second)):
            continue
        if unicodedata.normalize("NFC", chr(first) + chr(second)) != chr(cp):
            continue
        key = (first, second)
        old = pairs.get(key)
        if old is not None and old != cp:
            raise RuntimeError(f"duplicate composition {key}: U+{old:04X}, U+{cp:04X}")
        pairs[key] = cp
    return [(first, second, composite) for (first, second), composite in sorted(pairs.items())]


def load_properties(node_root: Path):
    script_dir = node_root / "Script"
    scx_dir = node_root / "Script_Extensions"
    if not script_dir.is_dir() or not scx_dir.is_dir():
        raise SystemExit(f"missing Unicode property directories under {node_root}")

    default_ignorable_path = node_root / "Binary_Property" / "Default_Ignorable_Code_Point.js"
    if not default_ignorable_path.is_file():
        raise SystemExit(f"missing {default_ignorable_path}")
    ignorable = compress(
        expand_intervals(parse_property_file(default_ignorable_path), is_scalar)
    )

    script_names = sorted(path.stem for path in script_dir.glob("*.js"))
    primary: dict[int, int] = {}
    for script_index, name in enumerate(script_names):
        values = expand_intervals(parse_property_file(script_dir / f"{name}.js"), is_assigned)
        for cp in values:
            primary[cp] = script_index

    scx_by_cp: dict[int, set[int]] = {}
    for script_index, name in enumerate(script_names):
        path = scx_dir / f"{name}.js"
        if not path.is_file():
            continue
        for cp in expand_intervals(parse_property_file(path), is_assigned):
            scx_by_cp.setdefault(cp, set()).add(script_index)

    return ignorable, script_names, primary, scx_by_cp


def emit_array(out, cpp_type: str, name: str, values, formatter) -> None:
    out.write(f"constexpr {cpp_type} {name}[] = {{\n")
    line: list[str] = []
    for value in values:
        line.append(formatter(value))
        if len(line) >= 8:
            out.write("    " + ", ".join(line) + ",\n")
            line = []
    if line:
        out.write("    " + ", ".join(line) + ",\n")
    out.write("};\n")
    out.write(f"constexpr std::size_t {name}Count = sizeof({name}) / sizeof({name}[0]);\n\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--node-root",
        type=Path,
        default=Path("/usr/share/nodejs/regenerate-unicode-properties"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "unicode_tables.inc",
    )
    args = parser.parse_args()

    ucd_version = unicodedata.unidata_version
    package_version = "unknown"
    version_file = args.node_root / "unicode-version.js"
    if version_file.is_file():
        match = re.search(r"['\"]([0-9]+\.[0-9]+\.[0-9]+)['\"]", version_file.read_text())
        if match:
            package_version = match.group(1)

    ccc_ranges = compress_ccc_ranges()
    decomp_entries, decomp_data = build_decompositions()
    casefold_entries, casefold_data = build_casefolds()
    compositions = build_compositions()
    ignorable, script_names, primary, scx_by_cp = load_properties(args.node_root)
    unknown_id = len(script_names)
    script_names_with_unknown = script_names + ["Unknown"]

    # Compress primary script assignments into ranges.
    script_ranges: list[tuple[int, int, int]] = []
    start = None
    current = None
    for cp in range(MAX_CP + 1):
        script = primary.get(cp, unknown_id) if is_scalar(cp) else unknown_id
        if start is None:
            start, current = cp, script
        elif script != current:
            if is_scalar(start) or start <= MAX_CP:
                script_ranges.append((start, cp - 1, current))
            start, current = cp, script
    if start is not None:
        script_ranges.append((start, MAX_CP, current))

    # Store only Script_Extensions values that are not exactly the primary script.
    scx_entries: list[tuple[int, int, int]] = []
    scx_data: list[int] = []
    for cp in sorted(scx_by_cp):
        scripts = scx_by_cp[cp]
        if scripts == {primary.get(cp, unknown_id)}:
            continue
        values = sorted(scripts)
        scx_entries.append((cp, len(scx_data), len(values)))
        scx_data.extend(values)

    with args.output.open("w", encoding="utf-8") as out:
        out.write("// Generated by tools/generate_unicode_data.py. Do not edit.\n")
        out.write(f"// NFKC/casefold data: Unicode {ucd_version} (Python unicodedata)\n")
        out.write(f"// Script data source: Unicode {package_version} (filtered to assigned code points)\n")
        out.write("// clang-format off\n")
        out.write("namespace dataeng::tables {\n\n")
        out.write(f"constexpr char kUnicodeVersionString[] = \"{ucd_version}\";\n\n")

        emit_array(
            out,
            "CccRange",
            "kCccRanges",
            ccc_ranges,
            lambda v: f"{{0x{v[0]:X}, 0x{v[1]:X}, {v[2]}}}",
        )
        emit_array(
            out,
            "MappingEntry",
            "kDecompEntries",
            decomp_entries,
            lambda v: f"{{0x{v[0]:X}, {v[1]}u, {v[2]}u}}",
        )
        emit_array(out, "char32_t", "kDecompData", decomp_data, lambda v: f"0x{v:X}")
        emit_array(
            out,
            "MappingEntry",
            "kCasefoldEntries",
            casefold_entries,
            lambda v: f"{{0x{v[0]:X}, {v[1]}u, {v[2]}u}}",
        )
        emit_array(out, "char32_t", "kCasefoldData", casefold_data, lambda v: f"0x{v:X}")
        emit_array(
            out,
            "ComposeEntry",
            "kComposeEntries",
            compositions,
            lambda v: f"{{0x{v[0]:X}, 0x{v[1]:X}, 0x{v[2]:X}}}",
        )
        emit_array(
            out,
            "Range",
            "kIgnorableRanges",
            ignorable,
            lambda v: f"{{0x{v[0]:X}, 0x{v[1]:X}}}",
        )
        emit_array(
            out,
            "ScriptRange",
            "kScriptRanges",
            script_ranges,
            lambda v: f"{{0x{v[0]:X}, 0x{v[1]:X}, {v[2]}}}",
        )
        emit_array(
            out,
            "const char*",
            "kScriptNames",
            script_names_with_unknown,
            lambda v: f'"{v}"',
        )
        emit_array(
            out,
            "ScxEntry",
            "kScxEntries",
            scx_entries,
            lambda v: f"{{0x{v[0]:X}, {v[1]}u, {v[2]}u}}",
        )
        emit_array(out, "std::uint16_t", "kScxData", scx_data, lambda v: str(v))
        out.write("}  // namespace dataeng::tables\n")

    print(
        f"wrote {args.output}: Unicode {ucd_version}; "
        f"{len(decomp_entries)} NFKD mappings, {len(casefold_entries)} casefold mappings, "
        f"{len(compositions)} compositions, {len(script_ranges)} script ranges, "
        f"{len(scx_entries)} script-extension exceptions",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
