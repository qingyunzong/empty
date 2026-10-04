#include "lt/parse.hpp"

#include <fstream>
#include <sstream>
#include <stdexcept>

namespace lt {

namespace {

[[noreturn]] void fail(const std::string& src, std::size_t line,
                       const std::string& msg) {
    throw std::runtime_error(src + ":" + std::to_string(line) + ": " + msg);
}

Section& find_section(Object& obj, const std::string& name,
                      const std::string& src, std::size_t line) {
    for (auto& sec : obj.sections)
        if (sec.name == name)
            return sec;
    fail(src, line, "unknown section '" + name + "'");
}

std::uint64_t parse_u64(const std::string& tok, const std::string& src,
                        std::size_t line) {
    try {
        return std::stoull(tok, nullptr, 0);
    } catch (...) {
        fail(src, line, "bad number '" + tok + "'");
    }
}

std::int64_t parse_i64(const std::string& tok, const std::string& src,
                       std::size_t line) {
    try {
        return std::stoll(tok, nullptr, 0);
    } catch (...) {
        fail(src, line, "bad number '" + tok + "'");
    }
}

} // namespace

Object parse_object(std::istream& in, const std::string& source_name) {
    Object obj;
    obj.name = source_name;
    std::string text;
    std::size_t line_no = 0;
    while (std::getline(in, text)) {
        ++line_no;
        auto hash = text.find('#');
        if (hash != std::string::npos)
            text.erase(hash);
        std::istringstream ls(text);
        std::string kw;
        if (!(ls >> kw))
            continue;
        if (kw == "object") {
            if (!(ls >> obj.name))
                fail(source_name, line_no, "object: missing name");
        } else if (kw == "section") {
            Section sec;
            std::string tok;
            if (!(ls >> sec.name))
                fail(source_name, line_no, "section: missing name");
            std::size_t size = 0;
            while (ls >> tok) {
                if (tok == "keep") {
                    sec.keep = true;
                } else if (tok.rfind("size=", 0) == 0) {
                    size = static_cast<std::size_t>(
                        parse_u64(tok.substr(5), source_name, line_no));
                } else if (tok.rfind("align=", 0) == 0) {
                    sec.align = static_cast<std::size_t>(
                        parse_u64(tok.substr(6), source_name, line_no));
                    if (sec.align == 0 || (sec.align & (sec.align - 1)) != 0)
                        fail(source_name, line_no,
                             "align must be a power of two");
                } else {
                    fail(source_name, line_no, "section: bad token '" + tok + "'");
                }
            }
            sec.data.assign(size, 0);
            obj.sections.push_back(std::move(sec));
        } else if (kw == "data") {
            std::string sec_name, hex;
            std::uint64_t off;
            if (!(ls >> sec_name >> off >> hex))
                fail(source_name, line_no, "data: need <section> <offset> <hex>");
            auto& sec = find_section(obj, sec_name, source_name, line_no);
            if (hex.size() % 2 != 0)
                fail(source_name, line_no, "data: odd hex length");
            std::size_t need = static_cast<std::size_t>(off) + hex.size() / 2;
            if (need > sec.data.size())
                fail(source_name, line_no, "data: past end of section");
            for (std::size_t i = 0; i < hex.size(); i += 2) {
                auto byte = static_cast<std::uint8_t>(
                    std::stoul(hex.substr(i, 2), nullptr, 16));
                sec.data[static_cast<std::size_t>(off) + i / 2] = byte;
            }
        } else if (kw == "sym") {
            Symbol sym;
            std::string bind, kind;
            if (!(ls >> sym.name >> bind >> kind))
                fail(source_name, line_no,
                     "sym: need <name> <strong|weak> <def|undef>");
            if (bind == "strong")
                sym.binding = Binding::Strong;
            else if (bind == "weak")
                sym.binding = Binding::Weak;
            else
                fail(source_name, line_no, "sym: bad binding '" + bind + "'");
            if (kind == "def") {
                sym.defined = true;
                std::string off;
                if (!(ls >> sym.section >> off))
                    fail(source_name, line_no,
                         "sym def: need <section> <offset>");
                sym.value = parse_u64(off, source_name, line_no);
                find_section(obj, sym.section, source_name, line_no);
            } else if (kind == "undef") {
                sym.defined = false;
            } else {
                fail(source_name, line_no, "sym: bad kind '" + kind + "'");
            }
            obj.symbols.push_back(std::move(sym));
        } else if (kw == "reloc") {
            std::string sec_name, kind, sym;
            std::uint64_t off;
            if (!(ls >> sec_name >> off >> kind >> sym))
                fail(source_name, line_no,
                     "reloc: need <section> <offset> <kind> <symbol> [addend]");
            Reloc rel;
            if (kind == "ABS32")
                rel.kind = RelocKind::Abs32;
            else if (kind == "ABS64")
                rel.kind = RelocKind::Abs64;
            else if (kind == "PC32")
                rel.kind = RelocKind::Pc32;
            else
                fail(source_name, line_no, "reloc: bad kind '" + kind + "'");
            rel.offset = static_cast<std::size_t>(off);
            rel.symbol = sym;
            std::string addend;
            if (ls >> addend)
                rel.addend = parse_i64(addend, source_name, line_no);
            auto& sec = find_section(obj, sec_name, source_name, line_no);
            std::size_t width = rel.kind == RelocKind::Abs64 ? 8 : 4;
            if (rel.offset + width > sec.data.size())
                fail(source_name, line_no, "reloc: past end of section");
            sec.relocs.push_back(std::move(rel));
        } else {
            fail(source_name, line_no, "unknown directive '" + kw + "'");
        }
    }
    return obj;
}

Object parse_object_file(const std::string& path) {
    std::ifstream in(path);
    if (!in)
        throw std::runtime_error("cannot open '" + path + "'");
    return parse_object(in, path);
}

} // namespace lt
