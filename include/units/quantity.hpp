#pragma once

#include "units/dimension.hpp"
#include "units/rational.hpp"

#include <stdexcept>
#include <string>

namespace units {

// A quantity: an exact rational magnitude together with a dimension.
// Multiplication/division combine dimensions; addition and subtraction
// require identical dimensions and throw std::domain_error otherwise.
class Quantity {
public:
    Quantity() : value_(0), dim_() {}
    explicit Quantity(Rational value, Dimension dim = Dimension())
        : value_(value), dim_(dim) {}
    Quantity(std::int64_t n, std::int64_t d, Dimension dim)
        : value_(n, d), dim_(dim) {}

    const Rational& value() const { return value_; }
    const Dimension& dim() const { return dim_; }

    Quantity operator+(const Quantity& o) const {
        require_compatible(o, "+");
        return Quantity(value_ + o.value_, dim_);
    }

    Quantity operator-(const Quantity& o) const {
        require_compatible(o, "-");
        return Quantity(value_ - o.value_, dim_);
    }

    Quantity operator-() const { return Quantity(-value_, dim_); }

    Quantity operator*(const Quantity& o) const {
        return Quantity(value_ * o.value_, dim_ + o.dim_);
    }

    Quantity operator/(const Quantity& o) const {
        return Quantity(value_ / o.value_, dim_ - o.dim_);
    }

    Quantity pow(int k) const { return Quantity(value_.pow(k), dim_.scaled(k)); }

    bool operator==(const Quantity& o) const {
        return value_ == o.value_ && dim_ == o.dim_;
    }
    bool operator!=(const Quantity& o) const { return !(*this == o); }

    std::string to_string() const {
        return value_.to_string() + " [" + dim_.to_string() + "]";
    }

private:
    Rational value_;
    Dimension dim_;

    void require_compatible(const Quantity& o, const char* op) const {
        if (dim_ != o.dim_)
            throw std::domain_error(std::string("cannot ") + op +
                                    " quantities of different dimensions: [" +
                                    dim_.to_string() + "] vs [" +
                                    o.dim_.to_string() + "]");
    }
};

} // namespace units
