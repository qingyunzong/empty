// End-to-end test: run the convolve executable on temp files and check output.

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "../src/convolution.hpp"

#ifndef CONVOLVE_EXE
#define CONVOLVE_EXE "convolve"
#endif

static int failures = 0;

static void write_file(const std::filesystem::path& p, const std::string& s) {
    std::ofstream f(p);
    f << s;
}

static std::string read_all(const std::filesystem::path& p) {
    std::ifstream f(p);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static void check(bool cond, const char* msg) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++failures;
    }
}

int main() {
    namespace fs = std::filesystem;
    fs::path dir = fs::temp_directory_path() / "convolve_cli_test";
    fs::create_directories(dir);
    fs::path fa = dir / "a.txt", fb = dir / "b.txt", fout = dir / "out.txt";

    // Extreme cancellation through the real CLI:
    //   {M, -M} * {M, M} = {M^2, 0, -M^2}, M = INT64_MAX.
    const char* M = "9223372036854775807";
    write_file(fa, std::string(M) + " -" + M + "\n");
    write_file(fb, std::string(M) + " " + M + "\n");

    std::string cmd = std::string("\"") + CONVOLVE_EXE + "\" \"" + fa.string() +
                      "\" \"" + fb.string() + "\" > \"" + fout.string() + "\"";
    check(std::system(cmd.c_str()) == 0, "CLI exit status");

    conv::BigInt m2 = conv::BigInt::from_i64_product(INT64_MAX, INT64_MAX);
    std::string m2s = m2.to_string();
    std::string want = m2s + "\n0\n-" + m2s + "\n";
    std::string got = read_all(fout);
    if (got != want) {
        std::fprintf(stderr, "FAIL: CLI output mismatch:\n%s\nwant:\n%s\n",
                     got.c_str(), want.c_str());
        ++failures;
    }

    // Error handling: missing input file must fail with nonzero status.
    std::string bad = std::string("\"") + CONVOLVE_EXE +
                      "\" /nonexistent_a /nonexistent_b 2>/dev/null";
    check(std::system(bad.c_str()) != 0, "CLI fails on missing file");

    fs::remove_all(dir);
    if (failures == 0) std::puts("all CLI tests passed");
    return failures ? 1 : 0;
}
