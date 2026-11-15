#include "dataeng.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace dataeng {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kHalfPi = 0.5 * kPi;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kRadToDeg = 180.0 / kPi;
constexpr double kArcSecondsToRad = kPi / (180.0 * 3600.0);

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct Geodetic {
    double latitudeRadians = 0.0;
    double longitudeRadians = 0.0;
    double heightMeters = 0.0;
};

struct Planar {
    double easting = 0.0;
    double northing = 0.0;
};

bool finite(double value) {
    return std::isfinite(value);
}

bool finite(const Vec3& value) {
    return finite(value.x) && finite(value.y) && finite(value.z);
}

double normalizeLongitude(double longitude) {
    return std::remainder(longitude, kTwoPi);
}

bool within(double value, double low, double high) {
    const double scale =
        std::max({1.0, std::abs(value), std::abs(low), std::abs(high)});
    const double epsilon = 1.0e-12 * scale;
    return value >= low - epsilon && value <= high + epsilon;
}

double fitLongitude(double longitude, double low, double high) {
    longitude = normalizeLongitude(longitude);
    if (within(longitude, low, high)) {
        return longitude;
    }
    const double plus = longitude + kTwoPi;
    if (within(plus, low, high)) {
        return plus;
    }
    const double minus = longitude - kTwoPi;
    if (within(minus, low, high)) {
        return minus;
    }
    return longitude;
}

bool epochWithinDatum(const Datum& datum, double epoch) {
    if (!datum.isDynamic()) {
        return true;
    }
    return epoch >= datum.minEpoch && epoch <= datum.maxEpoch;
}

Vec3 geodeticToEcef(const Geodetic& geodetic, const Ellipsoid& ellipsoid) {
    const double sinLat = std::sin(geodetic.latitudeRadians);
    const double cosLat = std::cos(geodetic.latitudeRadians);
    const double sinLon = std::sin(geodetic.longitudeRadians);
    const double cosLon = std::cos(geodetic.longitudeRadians);
    const double e2 = ellipsoid.eccentricitySquared();
    const double primeVertical =
        ellipsoid.semiMajorAxisMeters /
        std::sqrt(1.0 - e2 * sinLat * sinLat);

    const double horizontal =
        (primeVertical + geodetic.heightMeters) * cosLat;
    return {horizontal * cosLon, horizontal * sinLon,
            (primeVertical * (1.0 - e2) + geodetic.heightMeters) * sinLat};
}

bool ecefToGeodetic(const Vec3& ecef, const Ellipsoid& ellipsoid,
                    Geodetic& geodetic) {
    if (!finite(ecef)) {
        return false;
    }

    const double a = ellipsoid.semiMajorAxisMeters;
    const double b = ellipsoid.semiMinorAxisMeters();
    const double e2 = ellipsoid.eccentricitySquared();
    const double p = std::hypot(ecef.x, ecef.y);

    if (p < 1.0e-9) {
        if (std::abs(ecef.z) < 1.0e-9) {
            return false;
        }
        geodetic.latitudeRadians =
            std::copysign(kHalfPi, ecef.z);
        geodetic.longitudeRadians = 0.0;
        geodetic.heightMeters = std::abs(ecef.z) - b;
        return finite(geodetic.latitudeRadians) &&
               finite(geodetic.longitudeRadians) &&
               finite(geodetic.heightMeters);
    }

    const double longitude = std::atan2(ecef.y, ecef.x);
    double latitude = std::atan2(ecef.z, p * (1.0 - e2));

    for (int iteration = 0; iteration < 20; ++iteration) {
        const double sinLat = std::sin(latitude);
        const double cosLat = std::cos(latitude);
        const double primeVertical =
            a / std::sqrt(1.0 - e2 * sinLat * sinLat);
        const double height =
            p * cosLat + ecef.z * sinLat -
            a * std::sqrt(1.0 - e2 * sinLat * sinLat);
        const double denominator =
            p * (1.0 - e2 * primeVertical / (primeVertical + height));
        if (!(primeVertical + height > 0.0) ||
            !finite(denominator)) {
            return false;
        }
        const double next = std::atan2(ecef.z, denominator);
        if (std::abs(next - latitude) < 1.0e-15) {
            latitude = next;
            break;
        }
        latitude = next;
    }

    const double sinLat = std::sin(latitude);
    const double cosLat = std::cos(latitude);
    const double height =
        p * cosLat + ecef.z * sinLat -
        a * std::sqrt(1.0 - e2 * sinLat * sinLat);

    geodetic.latitudeRadians = latitude;
    geodetic.longitudeRadians = normalizeLongitude(longitude);
    geodetic.heightMeters = height;
    return finite(geodetic.latitudeRadians) &&
           finite(geodetic.longitudeRadians) &&
           finite(geodetic.heightMeters);
}

struct TmSeries {
    double n = 0.0;
    double radius = 0.0;
    std::array<double, 6> alpha{};
    std::array<double, 6> beta{};
};

TmSeries makeTmSeries(const Ellipsoid& ellipsoid) {
    const double f = ellipsoid.flattening();
    const double n = f / (2.0 - f);
    const double n2 = n * n;
    const double n3 = n2 * n;
    const double n4 = n3 * n;
    const double n5 = n4 * n;
    const double n6 = n5 * n;

    TmSeries series;
    series.n = n;
    series.radius =
        ellipsoid.semiMajorAxisMeters / (1.0 + n) *
        (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0);
    series.alpha = {
        0.5 * n - 2.0 / 3.0 * n2 + 5.0 / 16.0 * n3 +
            41.0 / 180.0 * n4 - 127.0 / 288.0 * n5 +
            7891.0 / 37800.0 * n6,
        13.0 / 48.0 * n2 - 3.0 / 5.0 * n3 + 557.0 / 1440.0 * n4 +
            281.0 / 630.0 * n5 - 1983433.0 / 1935360.0 * n6,
        61.0 / 240.0 * n3 - 103.0 / 140.0 * n4 +
            15061.0 / 26880.0 * n5 + 167603.0 / 181440.0 * n6,
        49561.0 / 161280.0 * n4 - 179.0 / 168.0 * n5 +
            6601661.0 / 7257600.0 * n6,
        34729.0 / 80640.0 * n5 - 3418889.0 / 1995840.0 * n6,
        212378941.0 / 319334400.0 * n6};
    series.beta = {
        0.5 * n - 2.0 / 3.0 * n2 + 37.0 / 96.0 * n3 -
            1.0 / 360.0 * n4 - 81.0 / 512.0 * n5 +
            96199.0 / 604800.0 * n6,
        1.0 / 48.0 * n2 + 1.0 / 15.0 * n3 - 437.0 / 1440.0 * n4 +
            46.0 / 105.0 * n5 - 1118711.0 / 3870720.0 * n6,
        17.0 / 480.0 * n3 - 37.0 / 840.0 * n4 -
            209.0 / 4480.0 * n5 + 5569.0 / 90720.0 * n6,
        4397.0 / 161280.0 * n4 - 11.0 / 504.0 * n5 -
            830251.0 / 7257600.0 * n6,
        4583.0 / 161280.0 * n5 - 108847.0 / 3991680.0 * n6,
        20648693.0 / 638668800.0 * n6};
    return series;
}

bool tmRaw(double latitude, double longitudeDelta, double eccentricity,
           const TmSeries& series, double& xi, double& eta) {
    const double tau = std::tan(latitude);
    const double tau1 = std::hypot(1.0, tau);
    const double sigma =
        std::sinh(eccentricity *
                  std::atanh(eccentricity * tau / tau1));
    const double tauPrime = tau * std::hypot(1.0, sigma) -
                            sigma * tau1;
    const double cosLambda = std::cos(longitudeDelta);
    const double sinLambda = std::sin(longitudeDelta);
    const double xiPrime = std::atan2(tauPrime, cosLambda);
    const double etaPrime =
        std::asinh(sinLambda /
                   std::hypot(tauPrime, cosLambda));

    xi = xiPrime;
    eta = etaPrime;
    for (int j = 1; j <= 6; ++j) {
        const double order = 2.0 * static_cast<double>(j);
        xi += series.alpha[static_cast<std::size_t>(j - 1)] *
              std::sin(order * xiPrime) *
              std::cosh(order * etaPrime);
        eta += series.alpha[static_cast<std::size_t>(j - 1)] *
               std::cos(order * xiPrime) *
               std::sinh(order * etaPrime);
    }
    return finite(xi) && finite(eta);
}

double tauf(double tauPrime, double eccentricity) {
    const double oneMinusE2 = 1.0 - eccentricity * eccentricity;
    const double tolerance =
        1.0e-15 * std::max(1.0, std::abs(tauPrime));
    double tau = tauPrime / oneMinusE2;

    for (int iteration = 0; iteration < 15; ++iteration) {
        const double tau1 = std::hypot(1.0, tau);
        const double sigma =
            std::sinh(eccentricity *
                      std::atanh(eccentricity * tau / tau1));
        const double tauPrimeActual =
            std::hypot(1.0, sigma) * tau - sigma * tau1;
        const double delta =
            (tauPrime - tauPrimeActual) *
            (1.0 + oneMinusE2 * tau * tau) /
            (oneMinusE2 * tau1 *
             std::hypot(1.0, tauPrimeActual));
        tau += delta;
        if (std::abs(delta) <= tolerance) {
            break;
        }
    }
    return tau;
}

bool tmForward(const Projection& projection, const Ellipsoid& ellipsoid,
               const Geodetic& geodetic, Planar& planar) {
    const TmSeries series = makeTmSeries(ellipsoid);
    const double eccentricity =
        std::sqrt(ellipsoid.eccentricitySquared());
    const double longitudeOrigin =
        projection.centralMeridianDegrees * kDegToRad;
    const double latitudeOrigin =
        projection.latitudeOfOriginDegrees * kDegToRad;
    const double delta =
        normalizeLongitude(geodetic.longitudeRadians - longitudeOrigin);

    if (std::abs(delta) >= kHalfPi - 1.0e-12) {
        return false;
    }

    double xi = 0.0;
    double eta = 0.0;
    double xiOrigin = 0.0;
    double etaOrigin = 0.0;
    if (!tmRaw(geodetic.latitudeRadians, delta, eccentricity, series, xi,
               eta) ||
        !tmRaw(latitudeOrigin, 0.0, eccentricity, series, xiOrigin,
               etaOrigin)) {
        return false;
    }

    planar.easting =
        projection.falseEastingMeters +
        projection.scaleFactor * series.radius * eta;
    planar.northing =
        projection.falseNorthingMeters +
        projection.scaleFactor * series.radius * (xi - xiOrigin);
    return finite(planar.easting) && finite(planar.northing);
}

bool tmInverse(const Projection& projection, const Ellipsoid& ellipsoid,
               const Planar& planar, Geodetic& geodetic) {
    const TmSeries series = makeTmSeries(ellipsoid);
    const double eccentricity =
        std::sqrt(ellipsoid.eccentricitySquared());
    const double longitudeOrigin =
        projection.centralMeridianDegrees * kDegToRad;
    const double latitudeOrigin =
        projection.latitudeOfOriginDegrees * kDegToRad;
    const double scaledRadius =
        projection.scaleFactor * series.radius;
    if (!(std::abs(scaledRadius) > 1.0e-12)) {
        return false;
    }

    double xiOrigin = 0.0;
    double etaOrigin = 0.0;
    if (!tmRaw(latitudeOrigin, 0.0, eccentricity, series, xiOrigin,
               etaOrigin)) {
        return false;
    }

    const double xi =
        xiOrigin +
        (planar.northing - projection.falseNorthingMeters) /
            scaledRadius;
    const double eta =
        (planar.easting - projection.falseEastingMeters) /
        scaledRadius;
    double xiPrime = xi;
    double etaPrime = eta;
    for (int j = 1; j <= 6; ++j) {
        const double order = 2.0 * static_cast<double>(j);
        xiPrime -= series.beta[static_cast<std::size_t>(j - 1)] *
                   std::sin(order * xi) * std::cosh(order * eta);
        etaPrime -= series.beta[static_cast<std::size_t>(j - 1)] *
                    std::cos(order * xi) * std::sinh(order * eta);
    }

    const double tauPrime =
        std::sin(xiPrime) /
        std::hypot(std::sinh(etaPrime), std::cos(xiPrime));
    const double lambda =
        std::atan2(std::sinh(etaPrime), std::cos(xiPrime));
    const double tau = tauf(tauPrime, eccentricity);

    geodetic.latitudeRadians = std::atan(tau);
    geodetic.longitudeRadians =
        normalizeLongitude(longitudeOrigin + lambda);
    return finite(geodetic.latitudeRadians) &&
           finite(geodetic.longitudeRadians);
}

bool webMercatorForward(const Projection& projection,
                        const Ellipsoid& ellipsoid,
                        const Geodetic& geodetic, Planar& planar) {
    const double longitudeOrigin =
        projection.centralMeridianDegrees * kDegToRad;
    const double latitudeOrigin =
        projection.latitudeOfOriginDegrees * kDegToRad;
    const double delta =
        normalizeLongitude(geodetic.longitudeRadians - longitudeOrigin);
    const double radius =
        projection.scaleFactor * ellipsoid.semiMajorAxisMeters;

    planar.easting =
        projection.falseEastingMeters + radius * delta;
    planar.northing =
        projection.falseNorthingMeters +
        radius * (std::asinh(std::tan(geodetic.latitudeRadians)) -
                  std::asinh(std::tan(latitudeOrigin)));
    return finite(planar.easting) && finite(planar.northing);
}

bool webMercatorInverse(const Projection& projection,
                        const Ellipsoid& ellipsoid,
                        const Planar& planar, Geodetic& geodetic) {
    const double longitudeOrigin =
        projection.centralMeridianDegrees * kDegToRad;
    const double latitudeOrigin =
        projection.latitudeOfOriginDegrees * kDegToRad;
    const double radius =
        projection.scaleFactor * ellipsoid.semiMajorAxisMeters;
    if (!(std::abs(radius) > 1.0e-12)) {
        return false;
    }

    const double delta =
        (planar.easting - projection.falseEastingMeters) / radius;
    const double y =
        (planar.northing - projection.falseNorthingMeters) / radius +
        std::asinh(std::tan(latitudeOrigin));

    geodetic.longitudeRadians =
        normalizeLongitude(longitudeOrigin + delta);
    geodetic.latitudeRadians = std::atan(std::sinh(y));
    return finite(geodetic.latitudeRadians) &&
           finite(geodetic.longitudeRadians);
}

bool projectForward(const Projection& projection,
                    const Ellipsoid& ellipsoid,
                    const Geodetic& geodetic, Planar& planar) {
    switch (projection.type) {
        case ProjectionType::TransverseMercator:
            return tmForward(projection, ellipsoid, geodetic, planar);
        case ProjectionType::WebMercator:
            return webMercatorForward(projection, ellipsoid, geodetic,
                                      planar);
    }
    return false;
}

bool projectInverse(const Projection& projection,
                    const Ellipsoid& ellipsoid,
                    const Planar& planar, Geodetic& geodetic) {
    switch (projection.type) {
        case ProjectionType::TransverseMercator:
            return tmInverse(projection, ellipsoid, planar, geodetic);
        case ProjectionType::WebMercator:
            return webMercatorInverse(projection, ellipsoid, planar,
                                      geodetic);
    }
    return false;
}

using Matrix3 = std::array<std::array<double, 3>, 3>;

bool helmertMatrix(const HelmertParameters& parameters, Matrix3& matrix,
                   Vec3& translation) {
    if (!parameters.finite()) {
        return false;
    }
    const double rx = parameters.rxArcSeconds * kArcSecondsToRad;
    const double ry = parameters.ryArcSeconds * kArcSecondsToRad;
    const double rz = parameters.rzArcSeconds * kArcSecondsToRad;
    const double scale = 1.0 + parameters.scalePpm * 1.0e-6;
    if (!(scale > 0.0) || !finite(scale)) {
        return false;
    }

    matrix = {{{scale, -scale * rz, scale * ry},
               {scale * rz, scale, -scale * rx},
               {-scale * ry, scale * rx, scale}}};
    translation = {parameters.txMeters, parameters.tyMeters,
                   parameters.tzMeters};
    return finite(translation);
}

Vec3 multiply(const Matrix3& matrix, const Vec3& vector) {
    return {matrix[0][0] * vector.x + matrix[0][1] * vector.y +
                matrix[0][2] * vector.z,
            matrix[1][0] * vector.x + matrix[1][1] * vector.y +
                matrix[1][2] * vector.z,
            matrix[2][0] * vector.x + matrix[2][1] * vector.y +
                matrix[2][2] * vector.z};
}

bool helmertForward(const Vec3& input,
                    const HelmertParameters& parameters, Vec3& output) {
    Matrix3 matrix{};
    Vec3 translation{};
    if (!helmertMatrix(parameters, matrix, translation)) {
        return false;
    }
    const Vec3 product = multiply(matrix, input);
    output = {translation.x + product.x, translation.y + product.y,
              translation.z + product.z};
    return finite(output);
}

bool helmertInverse(const Vec3& input,
                    const HelmertParameters& parameters, Vec3& output) {
    Matrix3 matrix{};
    Vec3 translation{};
    if (!helmertMatrix(parameters, matrix, translation)) {
        return false;
    }

    const double determinant =
        matrix[0][0] * (matrix[1][1] * matrix[2][2] -
                        matrix[1][2] * matrix[2][1]) -
        matrix[0][1] * (matrix[1][0] * matrix[2][2] -
                        matrix[1][2] * matrix[2][0]) +
        matrix[0][2] * (matrix[1][0] * matrix[2][1] -
                        matrix[1][1] * matrix[2][0]);
    if (!(std::abs(determinant) > 1.0e-18) || !finite(determinant)) {
        return false;
    }

    Matrix3 inverse{};
    inverse[0][0] =
        (matrix[1][1] * matrix[2][2] -
         matrix[1][2] * matrix[2][1]) /
        determinant;
    inverse[0][1] =
        (matrix[0][2] * matrix[2][1] -
         matrix[0][1] * matrix[2][2]) /
        determinant;
    inverse[0][2] =
        (matrix[0][1] * matrix[1][2] -
         matrix[0][2] * matrix[1][1]) /
        determinant;
    inverse[1][0] =
        (matrix[1][2] * matrix[2][0] -
         matrix[1][0] * matrix[2][2]) /
        determinant;
    inverse[1][1] =
        (matrix[0][0] * matrix[2][2] -
         matrix[0][2] * matrix[2][0]) /
        determinant;
    inverse[1][2] =
        (matrix[0][2] * matrix[1][0] -
         matrix[0][0] * matrix[1][2]) /
        determinant;
    inverse[2][0] =
        (matrix[1][0] * matrix[2][1] -
         matrix[1][1] * matrix[2][0]) /
        determinant;
    inverse[2][1] =
        (matrix[0][1] * matrix[2][0] -
         matrix[0][0] * matrix[2][1]) /
        determinant;
    inverse[2][2] =
        (matrix[0][0] * matrix[1][1] -
         matrix[0][1] * matrix[1][0]) /
        determinant;

    const Vec3 shifted{input.x - translation.x, input.y - translation.y,
                       input.z - translation.z};
    output = multiply(inverse, shifted);
    return finite(output);
}

bool datumToWgs84(const Datum& datum, const Vec3& input, double epoch,
                  Vec3& output) {
    if (!datum.hasTransformToWgs84) {
        output = input;
        return finite(output);
    }
    return helmertForward(input, datum.parametersAt(epoch), output);
}

bool datumFromWgs84(const Datum& datum, const Vec3& input, double epoch,
                    Vec3& output) {
    if (!datum.hasTransformToWgs84) {
        output = input;
        return finite(output);
    }
    return helmertInverse(input, datum.parametersAt(epoch), output);
}

bool checkLatitudeHeight(const Domain& domain, double latitude,
                         double height) {
    return within(latitude * kRadToDeg, domain.minLatitudeDegrees,
                  domain.maxLatitudeDegrees) &&
           within(height, domain.minHeightMeters,
                  domain.maxHeightMeters);
}

bool checkLongitude(const Domain& domain, double longitude) {
    return within(longitude * kRadToDeg, domain.minLongitudeDegrees,
                  domain.maxLongitudeDegrees);
}

bool checkCentralMeridianOffset(const Domain& domain,
                                const Projection& projection,
                                double longitude) {
    if (projection.type != ProjectionType::TransverseMercator) {
        return true;
    }
    const double delta = std::abs(normalizeLongitude(
        longitude - projection.centralMeridianDegrees * kDegToRad));
    return within(delta * kRadToDeg, 0.0,
                  domain.maxCentralMeridianOffsetDegrees);
}

bool checkProjectedBounds(const Domain& domain, const Planar& planar) {
    if (!domain.hasProjectedBounds) {
        return true;
    }
    return within(planar.easting, domain.minEastingMeters,
                  domain.maxEastingMeters) &&
           within(planar.northing, domain.minNorthingMeters,
                  domain.maxNorthingMeters);
}

Status decodePoint(const Crs& crs, const Point& point, Geodetic& geodetic) {
    if (!finite(point.first) || !finite(point.second) ||
        !finite(point.heightMeters)) {
        return Status::NonFiniteInput;
    }

    if (crs.kind == CrsKind::Geographic) {
        double latitude = 0.0;
        double longitude = 0.0;
        if (crs.axisOrder == AxisOrder::LatitudeLongitude) {
            latitude = point.first;
            longitude = point.second;
        } else {
            longitude = point.first;
            latitude = point.second;
        }
        if (crs.angularUnit == AngularUnit::Degrees) {
            latitude *= kDegToRad;
            longitude *= kDegToRad;
        }

        const double latitudeDegrees = latitude * kRadToDeg;
        if (!within(latitudeDegrees, -90.0, 90.0)) {
            return Status::OutOfDomain;
        }
        latitude = std::clamp(latitude, -kHalfPi, kHalfPi);
        if (!checkLongitude(crs.domain, longitude) ||
            !checkLatitudeHeight(crs.domain, latitude,
                                 point.heightMeters)) {
            return Status::OutOfDomain;
        }

        geodetic = {latitude, longitude, point.heightMeters};
        return Status::Ok;
    }

    if (!crs.projection.has_value()) {
        return Status::InvalidConfiguration;
    }

    double easting = 0.0;
    double northing = 0.0;
    if (crs.axisOrder == AxisOrder::NorthingEasting) {
        northing = point.first;
        easting = point.second;
    } else {
        easting = point.first;
        northing = point.second;
    }
    const Planar planar{easting, northing};
    if (!checkProjectedBounds(crs.domain, planar)) {
        return Status::OutOfDomain;
    }

    Geodetic decoded{};
    if (!projectInverse(*crs.projection, crs.datum.ellipsoid, planar,
                        decoded)) {
        return Status::ProjectionError;
    }
    if (!within(decoded.latitudeRadians * kRadToDeg, -90.0, 90.0)) {
        return Status::ProjectionError;
    }
    decoded.latitudeRadians =
        std::clamp(decoded.latitudeRadians, -kHalfPi, kHalfPi);

    const double fitted =
        fitLongitude(decoded.longitudeRadians,
                     crs.domain.minLongitudeDegrees * kDegToRad,
                     crs.domain.maxLongitudeDegrees * kDegToRad);
    if (!checkLongitude(crs.domain, fitted) ||
        !checkLatitudeHeight(crs.domain, decoded.latitudeRadians,
                             point.heightMeters) ||
        !checkCentralMeridianOffset(crs.domain, *crs.projection, fitted)) {
        return Status::OutOfDomain;
    }

    decoded.longitudeRadians = fitted;
    decoded.heightMeters = point.heightMeters;
    geodetic = decoded;
    return Status::Ok;
}

Status encodePoint(const Crs& crs, const Geodetic& geodetic,
                   PointResult& result) {
    if (!finite(geodetic.latitudeRadians) ||
        !finite(geodetic.longitudeRadians) ||
        !finite(geodetic.heightMeters)) {
        return Status::NumericError;
    }

    const double fitted =
        fitLongitude(geodetic.longitudeRadians,
                     crs.domain.minLongitudeDegrees * kDegToRad,
                     crs.domain.maxLongitudeDegrees * kDegToRad);
    if (!checkLongitude(crs.domain, fitted) ||
        !checkLatitudeHeight(crs.domain, geodetic.latitudeRadians,
                             geodetic.heightMeters)) {
        return Status::OutOfDomain;
    }

    if (crs.kind == CrsKind::Geographic) {
        double latitude = geodetic.latitudeRadians;
        double longitude = fitted;
        if (crs.angularUnit == AngularUnit::Degrees) {
            latitude *= kRadToDeg;
            longitude *= kRadToDeg;
        }
        if (crs.axisOrder == AxisOrder::LatitudeLongitude) {
            result.first = latitude;
            result.second = longitude;
        } else {
            result.first = longitude;
            result.second = latitude;
        }
        result.heightMeters = geodetic.heightMeters;
        result.status = Status::Ok;
        return finite(result.first) && finite(result.second) &&
                       finite(result.heightMeters)
                   ? Status::Ok
                   : Status::NumericError;
    }

    if (!crs.projection.has_value()) {
        return Status::InvalidConfiguration;
    }
    if (!checkCentralMeridianOffset(crs.domain, *crs.projection, fitted)) {
        return Status::OutOfDomain;
    }

    Geodetic projectedInput = geodetic;
    projectedInput.longitudeRadians = fitted;
    Planar planar{};
    if (!projectForward(*crs.projection, crs.datum.ellipsoid,
                        projectedInput, planar)) {
        return Status::ProjectionError;
    }
    if (!checkProjectedBounds(crs.domain, planar)) {
        return Status::OutOfDomain;
    }

    if (crs.axisOrder == AxisOrder::NorthingEasting) {
        result.first = planar.northing;
        result.second = planar.easting;
    } else {
        result.first = planar.easting;
        result.second = planar.northing;
    }
    result.heightMeters = geodetic.heightMeters;
    result.status = Status::Ok;
    return finite(result.first) && finite(result.second) &&
                   finite(result.heightMeters)
               ? Status::Ok
               : Status::NumericError;
}

double ecefDistance(const Vec3& lhs, const Vec3& rhs) {
    const double dx = lhs.x - rhs.x;
    const double dy = lhs.y - rhs.y;
    const double dz = lhs.z - rhs.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

RoundTripReport makeRoundTripReport(Status status, double error,
                                    double tolerance) {
    RoundTripReport report;
    report.status = status;
    report.errorMeters = error;
    report.toleranceMeters = tolerance;
    report.withinTolerance =
        status == Status::Ok && finite(error) && finite(tolerance) &&
        error <= tolerance;
    if (report.withinTolerance) {
        report.status = Status::Ok;
    } else if (status == Status::Ok) {
        report.status = Status::RoundTripToleranceExceeded;
    }
    return report;
}

}  // namespace

double Ellipsoid::flattening() const noexcept {
    if (inverseFlattening == 0.0) {
        return 0.0;
    }
    return 1.0 / inverseFlattening;
}

double Ellipsoid::eccentricitySquared() const noexcept {
    const double f = flattening();
    return f * (2.0 - f);
}

double Ellipsoid::semiMinorAxisMeters() const noexcept {
    return semiMajorAxisMeters * (1.0 - flattening());
}

bool Ellipsoid::valid() const noexcept {
    return finite(semiMajorAxisMeters) && semiMajorAxisMeters > 0.0 &&
           finite(inverseFlattening) &&
           (inverseFlattening == 0.0 || inverseFlattening > 1.0);
}

Ellipsoid Ellipsoid::wgs84() noexcept {
    return Ellipsoid{6378137.0, 298.257223563};
}

bool HelmertParameters::isZero() const noexcept {
    return txMeters == 0.0 && tyMeters == 0.0 && tzMeters == 0.0 &&
           rxArcSeconds == 0.0 && ryArcSeconds == 0.0 &&
           rzArcSeconds == 0.0 && scalePpm == 0.0;
}

bool HelmertParameters::finite() const noexcept {
    return dataeng::finite(txMeters) && dataeng::finite(tyMeters) &&
           dataeng::finite(tzMeters) && dataeng::finite(rxArcSeconds) &&
           dataeng::finite(ryArcSeconds) &&
           dataeng::finite(rzArcSeconds) && dataeng::finite(scalePpm);
}

HelmertParameters HelmertParameters::scaled(double factor) const noexcept {
    return {txMeters * factor,     tyMeters * factor,
            tzMeters * factor,     rxArcSeconds * factor,
            ryArcSeconds * factor, rzArcSeconds * factor,
            scalePpm * factor};
}

HelmertParameters& HelmertParameters::operator+=(
    const HelmertParameters& other) noexcept {
    txMeters += other.txMeters;
    tyMeters += other.tyMeters;
    tzMeters += other.tzMeters;
    rxArcSeconds += other.rxArcSeconds;
    ryArcSeconds += other.ryArcSeconds;
    rzArcSeconds += other.rzArcSeconds;
    scalePpm += other.scalePpm;
    return *this;
}

bool Datum::isDynamic() const noexcept {
    return hasTransformToWgs84 && !ratesPerYear.isZero();
}

HelmertParameters Datum::parametersAt(double epoch) const noexcept {
    if (!hasTransformToWgs84) {
        return {};
    }
    if (!isDynamic()) {
        return transformToWgs84;
    }
    return transformToWgs84 +
           ratesPerYear.scaled(epoch - referenceEpoch);
}

bool Datum::valid() const noexcept {
    if (!ellipsoid.valid() || !finite(referenceEpoch)) {
        return false;
    }
    if (std::isnan(minEpoch) || std::isnan(maxEpoch)) {
        return false;
    }
    if (minEpoch > maxEpoch) {
        return false;
    }
    if (isDynamic() &&
        (referenceEpoch < minEpoch || referenceEpoch > maxEpoch)) {
        return false;
    }
    if (!hasTransformToWgs84) {
        return ratesPerYear.isZero();
    }
    if (!transformToWgs84.finite() || !ratesPerYear.finite()) {
        return false;
    }
    return transformToWgs84.scalePpm > -1.0e6;
}

bool Projection::valid() const noexcept {
    return (type == ProjectionType::TransverseMercator ||
            type == ProjectionType::WebMercator) &&
           finite(centralMeridianDegrees) &&
           std::abs(centralMeridianDegrees) <= 360.0 &&
           finite(latitudeOfOriginDegrees) &&
           std::abs(latitudeOfOriginDegrees) < 90.0 &&
           finite(scaleFactor) && scaleFactor > 0.0 &&
           finite(falseEastingMeters) && finite(falseNorthingMeters);
}

bool Domain::valid() const noexcept {
    if (!finite(minLatitudeDegrees) || !finite(maxLatitudeDegrees) ||
        !finite(minLongitudeDegrees) || !finite(maxLongitudeDegrees) ||
        !finite(minHeightMeters) || !finite(maxHeightMeters) ||
        !finite(maxCentralMeridianOffsetDegrees)) {
        return false;
    }
    if (minLatitudeDegrees < -90.0 || maxLatitudeDegrees > 90.0 ||
        minLatitudeDegrees > maxLatitudeDegrees) {
        return false;
    }
    if (minLongitudeDegrees < -360.0 || maxLongitudeDegrees > 360.0 ||
        minLongitudeDegrees > maxLongitudeDegrees ||
        maxLongitudeDegrees - minLongitudeDegrees > 360.0 + 1.0e-9) {
        return false;
    }
    if (minHeightMeters >= maxHeightMeters) {
        return false;
    }
    if (maxCentralMeridianOffsetDegrees < 0.0 ||
        maxCentralMeridianOffsetDegrees >= 90.0) {
        return false;
    }
    if (hasProjectedBounds &&
        (!finite(minEastingMeters) || !finite(maxEastingMeters) ||
         !finite(minNorthingMeters) || !finite(maxNorthingMeters) ||
         minEastingMeters > maxEastingMeters ||
         minNorthingMeters > maxNorthingMeters)) {
        return false;
    }
    return true;
}

bool Crs::valid(std::string* error) const {
    auto fail = [error](const std::string& message) {
        if (error != nullptr) {
            *error = message;
        }
        return false;
    };

    if (kind != CrsKind::Geographic && kind != CrsKind::Projected) {
        return fail("invalid CRS kind");
    }
    if (axisOrder != AxisOrder::LongitudeLatitude &&
        axisOrder != AxisOrder::LatitudeLongitude &&
        axisOrder != AxisOrder::EastingNorthing &&
        axisOrder != AxisOrder::NorthingEasting) {
        return fail("invalid axis order");
    }
    if (angularUnit != AngularUnit::Degrees &&
        angularUnit != AngularUnit::Radians) {
        return fail("invalid angular unit");
    }
    if (!datum.valid()) {
        return fail("invalid datum definition");
    }
    if (!domain.valid()) {
        return fail("invalid domain definition");
    }
    if (!finite(roundTripToleranceMeters) ||
        roundTripToleranceMeters < 0.0) {
        return fail("round-trip tolerance must be finite and non-negative");
    }

    const bool angularOrder =
        axisOrder == AxisOrder::LongitudeLatitude ||
        axisOrder == AxisOrder::LatitudeLongitude;
    if (kind == CrsKind::Geographic) {
        if (projection.has_value()) {
            return fail("geographic CRS must not define a projection");
        }
        if (!angularOrder) {
            return fail(
                "geographic CRS requires a longitude/latitude axis order");
        }
    } else {
        if (!projection.has_value()) {
            return fail("projected CRS requires a projection");
        }
        if (!projection->valid()) {
            return fail("invalid projection definition");
        }
        if (angularOrder) {
            return fail(
                "projected CRS requires an easting/northing axis order");
        }
    }
    if (error != nullptr) {
        error->clear();
    }
    return true;
}

Crs Crs::wgs84(AxisOrder order) {
    Crs crs;
    crs.name = "WGS 84";
    crs.identifier = "EPSG:4326";
    crs.kind = CrsKind::Geographic;
    crs.axisOrder = order;
    crs.angularUnit = AngularUnit::Degrees;
    crs.datum.name = "World Geodetic System 1984";
    crs.datum.ellipsoid = Ellipsoid::wgs84();
    crs.domain.minLatitudeDegrees = -90.0;
    crs.domain.maxLatitudeDegrees = 90.0;
    crs.domain.minLongitudeDegrees = -180.0;
    crs.domain.maxLongitudeDegrees = 180.0;
    crs.roundTripToleranceMeters = 1.0e-3;
    return crs;
}

Crs Crs::utm(int zone, bool north, AxisOrder order) {
    if (zone < 1 || zone > 60) {
        throw std::invalid_argument("UTM zone must be in [1, 60]");
    }

    const double centralMeridian =
        static_cast<double>(zone) * 6.0 - 183.0;

    Crs crs;
    crs.name = "WGS 84 / UTM zone " + std::to_string(zone) +
               (north ? "N" : "S");
    crs.identifier =
        "EPSG:" + std::to_string((north ? 32600 : 32700) + zone);
    crs.kind = CrsKind::Projected;
    crs.axisOrder = order;
    crs.datum.name = "World Geodetic System 1984";
    crs.datum.ellipsoid = Ellipsoid::wgs84();
    crs.projection = Projection{ProjectionType::TransverseMercator,
                                centralMeridian,
                                0.0,
                                0.9996,
                                500000.0,
                                north ? 0.0 : 10000000.0};
    crs.domain.minLatitudeDegrees = -80.0;
    crs.domain.maxLatitudeDegrees = 84.0;
    crs.domain.minLongitudeDegrees = centralMeridian - 3.0;
    crs.domain.maxLongitudeDegrees = centralMeridian + 3.0;
    crs.domain.maxCentralMeridianOffsetDegrees = 3.0;
    crs.roundTripToleranceMeters = 1.0e-3;
    return crs;
}

Crs Crs::webMercator(AxisOrder order) {
    constexpr double kMaxMercator = 20037508.342789244;
    constexpr double kMaxMercatorLatitude = 85.0511287798066;

    Crs crs;
    crs.name = "WGS 84 / Pseudo-Mercator";
    crs.identifier = "EPSG:3857";
    crs.kind = CrsKind::Projected;
    crs.axisOrder = order;
    crs.datum.name = "World Geodetic System 1984";
    crs.datum.ellipsoid = Ellipsoid::wgs84();
    crs.projection = Projection{ProjectionType::WebMercator, 0.0, 0.0,
                                1.0, 0.0, 0.0};
    crs.domain.minLatitudeDegrees = -kMaxMercatorLatitude;
    crs.domain.maxLatitudeDegrees = kMaxMercatorLatitude;
    crs.domain.minLongitudeDegrees = -180.0;
    crs.domain.maxLongitudeDegrees = 180.0;
    crs.domain.hasProjectedBounds = true;
    crs.domain.minEastingMeters = -kMaxMercator;
    crs.domain.maxEastingMeters = kMaxMercator;
    crs.domain.minNorthingMeters = -kMaxMercator;
    crs.domain.maxNorthingMeters = kMaxMercator;
    crs.roundTripToleranceMeters = 1.0e-3;
    return crs;
}

const char* statusMessage(Status status) noexcept {
    switch (status) {
        case Status::Ok:
            return "ok";
        case Status::InvalidConfiguration:
            return "invalid CRS or transformer configuration";
        case Status::NonFiniteInput:
            return "coordinate contains a non-finite value";
        case Status::NonFiniteEpoch:
            return "epoch is not finite";
        case Status::EpochOutOfRange:
            return "epoch is outside the datum validity interval";
        case Status::OutOfDomain:
            return "coordinate is outside the CRS valid domain";
        case Status::ProjectionError:
            return "projection failed or produced a non-finite result";
        case Status::DatumError:
            return "datum transformation failed";
        case Status::NumericError:
            return "numeric conversion failed";
        case Status::RoundTripToleranceExceeded:
            return "round-trip error exceeds the published CRS bound";
    }
    return "unknown status";
}

Transformer::Transformer(Crs source, Crs target, double epoch)
    : source_(std::move(source)),
      target_(std::move(target)),
      epoch_(epoch) {
    std::string error;
    if (!source_.valid(&error)) {
        configurationError_ = "source CRS: " + error;
        return;
    }
    if (!target_.valid(&error)) {
        configurationError_ = "target CRS: " + error;
        return;
    }
    if (!finite(epoch_)) {
        configurationError_ = "transformer epoch must be finite";
    }
}

PointResult Transformer::transform(const Point& point) const {
    PointResult result;
    if (!configurationError_.empty()) {
        result.status = Status::InvalidConfiguration;
        return result;
    }

    const double epoch = point.epoch.value_or(epoch_);
    if (!finite(epoch)) {
        result.status = Status::NonFiniteEpoch;
        return result;
    }
    if (!epochWithinDatum(source_.datum, epoch) ||
        !epochWithinDatum(target_.datum, epoch)) {
        result.status = Status::EpochOutOfRange;
        return result;
    }

    Geodetic sourceGeodetic{};
    Status status = decodePoint(source_, point, sourceGeodetic);
    if (status != Status::Ok) {
        result.status = status;
        return result;
    }

    const Vec3 sourceEcef =
        geodeticToEcef(sourceGeodetic, source_.datum.ellipsoid);
    if (!finite(sourceEcef)) {
        result.status = Status::NumericError;
        return result;
    }

    Vec3 wgs84{};
    if (!datumToWgs84(source_.datum, sourceEcef, epoch, wgs84)) {
        result.status = Status::DatumError;
        return result;
    }

    Vec3 targetEcef{};
    if (!datumFromWgs84(target_.datum, wgs84, epoch, targetEcef)) {
        result.status = Status::DatumError;
        return result;
    }

    Geodetic targetGeodetic{};
    if (!ecefToGeodetic(targetEcef, target_.datum.ellipsoid,
                        targetGeodetic)) {
        result.status = Status::NumericError;
        return result;
    }

    status = encodePoint(target_, targetGeodetic, result);
    if (status != Status::Ok) {
        result = PointResult{};
        result.status = status;
    }
    return result;
}

std::vector<PointResult> Transformer::transform(
    std::span<const Point> points) const {
    std::vector<PointResult> results;
    results.reserve(points.size());
    for (const Point& point : points) {
        results.push_back(transform(point));
    }
    return results;
}

RoundTripReport Transformer::verifyRoundTrip(const Point& point) const {
    return verifyRoundTrip(
        point, source_.roundTripToleranceMeters +
                   target_.roundTripToleranceMeters);
}

RoundTripReport Transformer::verifyRoundTrip(
    const Point& point, double toleranceMeters) const {
    Transformer reverse(target_, source_, epoch_);
    return verifyRoundTripImpl(reverse, point, toleranceMeters);
}

RoundTripReport Transformer::verifyRoundTripImpl(
    const Transformer& reverse, const Point& point,
    double toleranceMeters) const {
    if (!configurationError_.empty()) {
        RoundTripReport report;
        report.status = Status::InvalidConfiguration;
        report.toleranceMeters = toleranceMeters;
        return report;
    }
    if (!finite(toleranceMeters) || toleranceMeters < 0.0) {
        RoundTripReport report;
        report.status = Status::InvalidConfiguration;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    const double epoch = point.epoch.value_or(epoch_);
    if (!finite(epoch)) {
        RoundTripReport report;
        report.status = Status::NonFiniteEpoch;
        report.toleranceMeters = toleranceMeters;
        return report;
    }
    if (!epochWithinDatum(source_.datum, epoch) ||
        !epochWithinDatum(target_.datum, epoch)) {
        RoundTripReport report;
        report.status = Status::EpochOutOfRange;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    Point forwardInput = point;
    forwardInput.epoch = epoch;
    const PointResult forward = transform(forwardInput);
    if (!forward.ok()) {
        RoundTripReport report;
        report.status = forward.status;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    const Point reverseInput{forward.first, forward.second,
                             forward.heightMeters, epoch};
    const PointResult reverseResult = reverse.transform(reverseInput);
    if (!reverseResult.ok()) {
        RoundTripReport report;
        report.status = reverseResult.status;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    Geodetic original{};
    Geodetic returned{};
    if (decodePoint(source_, forwardInput, original) != Status::Ok ||
        decodePoint(source_,
                    Point{reverseResult.first, reverseResult.second,
                          reverseResult.heightMeters, epoch},
                    returned) != Status::Ok) {
        RoundTripReport report;
        report.status = Status::NumericError;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    const Vec3 originalEcef =
        geodeticToEcef(original, source_.datum.ellipsoid);
    const Vec3 returnedEcef =
        geodeticToEcef(returned, source_.datum.ellipsoid);
    if (!finite(originalEcef) || !finite(returnedEcef)) {
        RoundTripReport report;
        report.status = Status::NumericError;
        report.toleranceMeters = toleranceMeters;
        return report;
    }

    return makeRoundTripReport(
        Status::Ok, ecefDistance(originalEcef, returnedEcef),
        toleranceMeters);
}

std::vector<RoundTripReport> Transformer::verifyRoundTrip(
    std::span<const Point> points) const {
    std::vector<RoundTripReport> reports;
    reports.reserve(points.size());
    const double tolerance =
        source_.roundTripToleranceMeters +
        target_.roundTripToleranceMeters;
    const Transformer reverse(target_, source_, epoch_);
    for (const Point& point : points) {
        reports.push_back(
            verifyRoundTripImpl(reverse, point, tolerance));
    }
    return reports;
}

namespace {

RoundTripReport crsRoundTrip(const Crs& crs, const Point& point,
                             double epoch, double toleranceMeters) {
    RoundTripReport report;
    report.toleranceMeters = toleranceMeters;

    std::string error;
    if (!crs.valid(&error)) {
        report.status = Status::InvalidConfiguration;
        return report;
    }
    if (!finite(epoch)) {
        report.status = Status::NonFiniteEpoch;
        return report;
    }
    if (!epochWithinDatum(crs.datum, epoch)) {
        report.status = Status::EpochOutOfRange;
        return report;
    }
    if (!finite(toleranceMeters) || toleranceMeters < 0.0) {
        report.status = Status::InvalidConfiguration;
        return report;
    }

    Point input = point;
    input.epoch = epoch;
    Geodetic first{};
    Status status = decodePoint(crs, input, first);
    if (status != Status::Ok) {
        report.status = status;
        return report;
    }

    Geodetic second{};
    if (crs.kind == CrsKind::Geographic) {
        const Vec3 ecef =
            geodeticToEcef(first, crs.datum.ellipsoid);
        if (!ecefToGeodetic(ecef, crs.datum.ellipsoid, second)) {
            report.status = Status::NumericError;
            return report;
        }
        PointResult encoded;
        status = encodePoint(crs, second, encoded);
        if (status != Status::Ok) {
            report.status = status;
            return report;
        }
        status = decodePoint(
            crs,
            Point{encoded.first, encoded.second, encoded.heightMeters,
                  epoch},
            second);
        if (status != Status::Ok) {
            report.status = status;
            return report;
        }
    } else {
        PointResult encoded;
        status = encodePoint(crs, first, encoded);
        if (status != Status::Ok) {
            report.status = status;
            return report;
        }
        status = decodePoint(
            crs,
            Point{encoded.first, encoded.second, encoded.heightMeters,
                  epoch},
            second);
        if (status != Status::Ok) {
            report.status = status;
            return report;
        }
    }

    const Vec3 firstEcef =
        geodeticToEcef(first, crs.datum.ellipsoid);
    const Vec3 secondEcef =
        geodeticToEcef(second, crs.datum.ellipsoid);
    if (!finite(firstEcef) || !finite(secondEcef)) {
        report.status = Status::NumericError;
        return report;
    }
    return makeRoundTripReport(
        Status::Ok, ecefDistance(firstEcef, secondEcef),
        toleranceMeters);
}

}  // namespace

RoundTripReport verifyCrsRoundTrip(const Crs& crs, const Point& point,
                                   double epoch) {
    return crsRoundTrip(crs, point, epoch,
                        crs.roundTripToleranceMeters);
}

RoundTripReport verifyCrsRoundTrip(const Crs& crs, const Point& point,
                                   double epoch,
                                   double toleranceMeters) {
    return crsRoundTrip(crs, point, epoch, toleranceMeters);
}

}  // namespace dataeng
