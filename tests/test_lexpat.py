import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lexpat import Lexer, LexError, tokenize


def run_cli(spec_obj, data):
    """Run `python -m lexpat` in a subprocess with temp spec/input files."""
    with tempfile.TemporaryDirectory() as tmp:
        spec_path = Path(tmp) / "spec.json"
        input_path = Path(tmp) / "input.txt"
        spec_path.write_text(json.dumps(spec_obj), encoding="utf-8")
        if isinstance(data, bytes):
            input_path.write_bytes(data)
        else:
            input_path.write_text(data, encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-m", "lexpat", "--spec", str(spec_path),
             "--input", str(input_path)],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )


class LongestMatchTests(unittest.TestCase):
    SPEC = {"rules": [
        {"name": "kw", "regex": "if|else", "mode": "main"},
        {"name": "ident", "regex": "[a-z]+", "mode": "main"},
        {"name": "eqeq", "regex": "==", "mode": "main"},
        {"name": "eq", "regex": "=", "mode": "main"},
        {"name": "ws", "regex": "[ \n]+", "mode": "main", "skip": True},
    ]}

    def test_keyword_wins_tie_over_identifier(self):
        # Acceptance B: same-length keyword/identifier tie -> keyword.
        tokens = tokenize("if", self.SPEC)
        self.assertEqual([t["type"] for t in tokens], ["kw"])

    def test_longer_identifier_beats_keyword(self):
        tokens = tokenize("ifx", self.SPEC)
        self.assertEqual([t["type"] for t in tokens], ["ident"])
        self.assertEqual(tokens[0]["text"], "ifx")

    def test_longest_match_wins(self):
        tokens = tokenize("== =", self.SPEC)
        self.assertEqual([t["type"] for t in tokens], ["eqeq", "eq"])


class TokenFieldTests(unittest.TestCase):
    SPEC = {"rules": [
        {"name": "open", "regex": "\\{", "mode": "main", "push": "body"},
        {"name": "word", "regex": "[a-z]+", "mode": "main"},
        {"name": "word", "regex": "[a-z]+", "mode": "body"},
        {"name": "close", "regex": "\\}", "mode": "body", "pop": True},
        {"name": "ws", "regex": "\\s+", "mode": "main", "skip": True},
        {"name": "ws", "regex": "\\s+", "mode": "body", "skip": True},
    ]}

    def test_token_fields_and_mode_transitions(self):
        tokens = tokenize("ab {\ncd }", self.SPEC)
        self.assertEqual(tokens, [
            {"type": "word", "text": "ab", "line": 1, "col": 1,
             "mode_before": "main", "mode_after": "main"},
            {"type": "open", "text": "{", "line": 1, "col": 4,
             "mode_before": "main", "mode_after": "body"},
            {"type": "word", "text": "cd", "line": 2, "col": 1,
             "mode_before": "body", "mode_after": "body"},
            {"type": "close", "text": "}", "line": 2, "col": 4,
             "mode_before": "body", "mode_after": "main"},
        ])


class ErrorTests(unittest.TestCase):
    UNTERMINATED_SPEC = {"rules": [
        {"name": "string", "regex": "\"[^\"\n]*\"", "mode": "main"},
        {"name": "ident", "regex": "[a-z]+", "mode": "main"},
        {"name": "ws", "regex": "\\s+", "mode": "main", "skip": True},
    ]}

    def test_unterminated_string_line3_single_error(self):
        # Acceptance C: unterminated string on line 3 -> exactly one
        # LexError with an accurate position; CLI emits no partial tokens.
        src = "alpha\nbeta\n\"unterminated\n"
        with self.assertRaises(LexError) as ctx:
            tokenize(src, self.UNTERMINATED_SPEC)
        err = ctx.exception
        self.assertEqual(err.line, 3)
        self.assertEqual(err.col, 1)
        self.assertEqual(err.mode, "main")
        self.assertIn("string", err.expected)

        proc = run_cli(self.UNTERMINATED_SPEC, src)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        err_lines = [l for l in proc.stderr.splitlines() if l.strip()]
        self.assertEqual(len(err_lines), 1)
        payload = json.loads(err_lines[0])
        self.assertEqual(payload["line"], 3)
        self.assertEqual(payload["col"], 1)
        self.assertEqual(payload["mode"], "main")
        self.assertIn("string", payload["expected"])

    def test_pop_empty_stack_fails(self):
        # Acceptance D: popping the initial mode is an error.
        spec = {"rules": [
            {"name": "close", "regex": "\\)", "mode": "main", "pop": True},
            {"name": "a", "regex": "a", "mode": "main"},
        ]}
        with self.assertRaises(LexError) as ctx:
            tokenize("a)", spec)
        self.assertIn("pop", ctx.exception.message)
        self.assertEqual((ctx.exception.line, ctx.exception.col), (1, 2))

    def test_stack_depth_64_ok_65_fails(self):
        # Acceptance D: depth 64 is the limit, depth 65 overflows.
        spec = {"rules": [
            {"name": "open", "regex": "\\(", "mode": "main", "push": "nest"},
            {"name": "open", "regex": "\\(", "mode": "nest", "push": "nest"},
            {"name": "close", "regex": "\\)", "mode": "nest", "pop": True},
        ]}
        tokens = tokenize("(" * 63 + ")" * 63, spec)  # peak depth 64
        self.assertEqual(len(tokens), 126)
        with self.assertRaises(LexError) as ctx:
            tokenize("(" * 64, spec)  # would reach depth 65
        self.assertIn("overflow", ctx.exception.message)

    def test_empty_match_fails(self):
        spec = {"rules": [
            {"name": "maybe_x", "regex": "x*", "mode": "main"},
            {"name": "a", "regex": "a", "mode": "main"},
        ]}
        with self.assertRaises(LexError) as ctx:
            tokenize("b", spec)
        self.assertIn("empty", ctx.exception.message)

    def test_unknown_character_reports_expected(self):
        spec = {"rules": [{"name": "a", "regex": "a", "mode": "main"}]}
        with self.assertRaises(LexError) as ctx:
            tokenize("aab", spec)
        err = ctx.exception
        self.assertEqual((err.line, err.col, err.mode), (1, 3, "main"))
        self.assertEqual(err.expected, ["a"])

    def test_capturing_groups_forbidden(self):
        spec = {"rules": [{"name": "bad", "regex": "(ab)+", "mode": "main"}]}
        with self.assertRaises(LexError):
            Lexer(spec)
        ok = {"rules": [{"name": "ok", "regex": "(?:ab)+", "mode": "main"}]}
        self.assertEqual(tokenize("abab", ok)[0]["text"], "abab")

    def test_unterminated_comment_fails_at_eof(self):
        spec = {"rules": [
            {"name": "ws", "regex": "\\s+", "mode": "main", "skip": True},
            {"name": "begin", "regex": "/\\*", "mode": "main",
             "push": "comment", "skip": True},
            {"name": "end", "regex": "\\*/", "mode": "comment",
             "pop": True, "skip": True},
            {"name": "body", "regex": "(?s:.)", "mode": "comment", "skip": True},
            {"name": "a", "regex": "a", "mode": "main"},
        ]}
        with self.assertRaises(LexError) as ctx:
            tokenize("a /* never closed", spec)
        err = ctx.exception
        self.assertEqual(err.mode, "comment")
        self.assertIn("unterminated", err.message)
        self.assertIn("end", err.expected)


class CliTests(unittest.TestCase):
    def test_cli_outputs_jsonl(self):
        spec = {"rules": [
            {"name": "word", "regex": "[a-z]+", "mode": "main"},
            {"name": "ws", "regex": "\\s+", "mode": "main", "skip": True},
        ]}
        proc = run_cli(spec, "hello world\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual([r["type"] for r in rows], ["word", "word"])
        self.assertEqual(rows[0], {"type": "word", "text": "hello", "line": 1,
                                   "col": 1, "mode_before": "main",
                                   "mode_after": "main"})
        self.assertEqual(rows[1]["col"], 7)

    def test_cli_rejects_bom(self):
        spec = {"rules": [{"name": "a", "regex": "a", "mode": "main"}]}
        proc = run_cli(spec, b"\xef\xbb\xbfa")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("BOM", proc.stderr)

    def test_cli_rejects_invalid_utf8(self):
        spec = {"rules": [{"name": "a", "regex": "a", "mode": "main"}]}
        proc = run_cli(spec, b"aa\xff")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        payload = json.loads(proc.stderr.strip())
        self.assertEqual(payload["line"], 1)
        self.assertEqual(payload["col"], 3)


# --- Acceptance A: nested modes vs an independent char-by-char scanner ---

SPEC_A = {"rules": [
    {"name": "kw", "regex": "if|else|while", "mode": "main"},
    {"name": "ident", "regex": "[a-z]+", "mode": "main"},
    {"name": "num", "regex": "[0-9]+", "mode": "main"},
    {"name": "ws", "regex": "[ \t\n]+", "mode": "main", "skip": True},
    {"name": "str_begin", "regex": "\"", "mode": "main", "push": "string"},
    {"name": "str_text", "regex": "[^\"\\\\\n]+", "mode": "string"},
    {"name": "str_esc", "regex": "\\\\.", "mode": "string"},
    {"name": "str_end", "regex": "\"", "mode": "string", "pop": True},
    {"name": "comment_begin", "regex": "/\\*", "mode": "main",
     "push": "comment", "skip": True},
    {"name": "comment_nest", "regex": "/\\*", "mode": "comment",
     "push": "comment", "skip": True},
    {"name": "comment_end", "regex": "\\*/", "mode": "comment",
     "pop": True, "skip": True},
    {"name": "comment_body", "regex": "[^/*]+|/(?!\\*)|\\*(?!/)",
     "mode": "comment", "skip": True},
]}


def _tok(ttype, text, line, col, mode_before, mode_after):
    return {"type": ttype, "text": text, "line": line, "col": col,
            "mode_before": mode_before, "mode_after": mode_after}


def reference_scan(src):
    """Independent char-by-char scanner for SPEC_A (no `re` involved)."""
    tokens = []
    pos = 0
    line = 1
    col = 1
    stack = ["main"]
    n = len(src)

    def advance(segment):
        nonlocal line, col
        newlines = segment.count("\n")
        if newlines:
            line += newlines
            col = len(segment) - segment.rfind("\n")
        else:
            col += len(segment)

    while pos < n:
        mode = stack[-1]
        ch = src[pos]
        if mode == "main":
            if ch in " \t\n":
                end = pos
                while end < n and src[end] in " \t\n":
                    end += 1
                advance(src[pos:end])
                pos = end
            elif src.startswith("/*", pos):
                stack.append("comment")
                advance("/*")
                pos += 2
            elif ch == '"':
                tokens.append(_tok("str_begin", '"', line, col, "main", "string"))
                stack.append("string")
                advance('"')
                pos += 1
            elif "0" <= ch <= "9":
                end = pos
                while end < n and "0" <= src[end] <= "9":
                    end += 1
                segment = src[pos:end]
                tokens.append(_tok("num", segment, line, col, "main", "main"))
                advance(segment)
                pos = end
            elif "a" <= ch <= "z":
                end = pos
                while end < n and "a" <= src[end] <= "z":
                    end += 1
                segment = src[pos:end]
                ttype = "kw" if segment in ("if", "else", "while") else "ident"
                tokens.append(_tok(ttype, segment, line, col, "main", "main"))
                advance(segment)
                pos = end
            else:
                raise AssertionError(f"reference: unexpected {ch!r} at {line}:{col}")
        elif mode == "string":
            if ch == "\\":
                segment = src[pos:pos + 2]
                tokens.append(_tok("str_esc", segment, line, col, "string", "string"))
                advance(segment)
                pos += 2
            elif ch == '"':
                tokens.append(_tok("str_end", '"', line, col, "string", "main"))
                stack.pop()
                advance('"')
                pos += 1
            else:
                end = pos
                while end < n and src[end] not in '"\\\n':
                    end += 1
                segment = src[pos:end]
                tokens.append(_tok("str_text", segment, line, col, "string", "string"))
                advance(segment)
                pos = end
        else:  # comment
            if src.startswith("/*", pos):
                stack.append("comment")
                advance("/*")
                pos += 2
            elif src.startswith("*/", pos):
                stack.pop()
                advance("*/")
                pos += 2
            else:
                advance(ch)
                pos += 1
    if stack != ["main"]:
        raise AssertionError("reference: unterminated construct")
    return tokens


def gen_string(rng):
    parts = []
    for _ in range(rng.randint(0, 5)):
        if rng.randrange(3) == 0:
            parts.append(rng.choice(["\\\\", "\\\"", "\\n", "\\t"]))
        else:
            parts.append("".join(rng.choices("abc 123 ", k=rng.randint(1, 5))))
    return '"' + "".join(parts) + '"'


def gen_comment(rng, depth=0):
    body = []
    for _ in range(rng.randint(0, 4)):
        roll = rng.randrange(4)
        if roll == 0 and depth < 3:
            body.append(gen_comment(rng, depth + 1))
        elif roll == 1:
            body.append("".join(rng.choices("abc \n", k=rng.randint(1, 6))))
        elif roll == 2:
            body.append(rng.choice(["a/b", "a*b", "x / y", "x * y"]))
        else:
            body.append("\n")
    return "/*" + "".join(body) + "*/"


def gen_source(rng):
    parts = []
    for _ in range(rng.randint(1, 30)):
        roll = rng.randrange(6)
        if roll == 0:
            parts.append(rng.choice(["if", "else", "while"]))
        elif roll == 1:
            parts.append("".join(rng.choices("abcdefgwxyz", k=rng.randint(1, 8))))
        elif roll == 2:
            parts.append(str(rng.randint(0, 10 ** 6)))
        elif roll == 3:
            parts.append(rng.choice([" ", "\n", "  \n\t", "\n\n"]))
        elif roll == 4:
            parts.append(gen_string(rng))
        else:
            parts.append(gen_comment(rng))
    return "".join(parts)


class RandomizedConformanceTests(unittest.TestCase):
    def test_matches_reference_scanner_200_cases(self):
        # Acceptance A: nested block comments + string modes, compared
        # token-by-token with the independent reference scanner.
        rng = random.Random(20241001)
        lexer = Lexer(SPEC_A)
        for case in range(200):
            src = gen_source(rng)
            with self.subTest(case=case, src=src):
                self.assertEqual(lexer.tokenize(src), reference_scan(src))


if __name__ == "__main__":
    unittest.main()
