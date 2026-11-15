#pragma once

#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace dataeng {

inline constexpr double kUndefined = std::numeric_limits<double>::quiet_NaN();

struct Ellipsoid {
    double semiMajorAxisMeters = 6378137.0;
    // Zero denotes a sphere. Otherwise this is 1 / flattening.
    double inverseFlattening = 298.257223563;

    [[nodiscard]] double flattening() const noexcept;
    [[nodiscard]] double eccentricitySquared() const noexcept;
    [[nodiscard]] double semiMinorAxisMeters() const noexcept;
    [[nodiscard]] bool valid() const noexcept;

    [[nodiscard]] static Ellipsoid wgs84() noexcept;
};

// EPSG position-vector convention: translations in metres, rotations in
// arc-seconds and scale in parts per million.
struct HelmertParameters {
    double txMeters = 0.0;
    double tyMeters = 0.0;
    double tzMeters = 0.0;
    double rxArcSeconds = 0.0;
    double ryArcSeconds = 0.0;
    double rzArcSeconds = 0.0;
    double scalePpm = 0.0;

    [[nodiscard]] bool isZero() const noexcept;
    [[nodiscard]] bool finite() const noexcept;
    [[nodiscard]] HelmertParameters scaled(double factor) const noexcept;

    HelmertParameters& operator+=(const HelmertParameters& other) noexcept;
    friend HelmertParameters operator+(HelmertParameters lhs,
                                       const HelmertParameters& rhs) noexcept {
        lhs += rhs;
        return lhs;
    }
};

struct Datum {
    std::string name = "WGS 84";
    Ellipsoid ellipsoid = Ellipsoid::wgs84();

    // When false, the datum is treated as co-located with WGS 84 and only the
    // ellipsoid change is applied.
    bool hasTransformToWgs84 = false;
    double referenceEpoch = 2000.0;
    HelmertParameters transformToWgs84;
    HelmertParameters ratesPerYear;

    // Epoch limits are enforced only for dynamic datums.
    double minEpoch = -std::numeric_limits<double>::infinity();
    double maxEpoch = std::numeric_limits<double>::infinity();

    [[nodiscard]] bool isDynamic() const noexcept;
    [[nodiscard]] HelmertParameters parametersAt(double epoch) const noexcept;
    [[nodiscard]] bool valid() const noexcept;
};

enum class AxisOrder {
    LongitudeLatitude,
    LatitudeLongitude,
    EastingNorthing,
    NorthingEasting
};

enum class AngularUnit { Degrees, Radians };

enum class CrsKind { Geographic, Projected };

enum class ProjectionType { TransverseMercator, WebMercator };

struct Projection {
    ProjectionType type = ProjectionType::TransverseMercator;
    double centralMeridianDegrees = 0.0;
    double latitudeOfOriginDegrees = 0.0;
    double scaleFactor = 1.0;
    double falseEastingMeters = 0.0;
    double falseNorthingMeters = 0.0;

    [[nodiscard]] bool valid() const noexcept;
};

struct Domain {
    double minLatitudeDegrees = -90.0;
    double maxLatitudeDegrees = 90.0;
    double minLongitudeDegrees = -180.0;
    double maxLongitudeDegrees = 180.0;
    double minHeightMeters = -10000.0;
    double maxHeightMeters = 100000000.0;

    // Used for projected CRS. Transverse Mercator is singular at 90 degrees
    // from the central meridian.
    double maxCentralMeridianOffsetDegrees = 89.999;

    bool hasProjectedBounds = false;
    double minEastingMeters = -1.0e12;
    double maxEastingMeters = 1.0e12;
    double minNorthingMeters = -1.0e12;
    double maxNorthingMeters = 1.0e12;

    [[nodiscard]] bool valid() const noexcept;
};

struct Crs {
    std::string name;
    std::string identifier;
    CrsKind kind = CrsKind::Geographic;
    AxisOrder axisOrder = AxisOrder::LongitudeLatitude;
    AngularUnit angularUnit = AngularUnit::Degrees;
    Datum datum;
    std::optional<Projection> projection;
    Domain domain;

    // Published round-trip / operational bound used by the verifier.
    double roundTripToleranceMeters = 1.0e-3;

    [[nodiscard]] bool valid(std::string* error = nullptr) const;

    [[nodiscard]] static Crs wgs84(
        AxisOrder order = AxisOrder::LongitudeLatitude);
    [[nodiscard]] static Crs utm(
        int zone, bool north = true,
        AxisOrder order = AxisOrder::EastingNorthing);
    [[nodiscard]] static Crs webMercator(
        AxisOrder order = AxisOrder::EastingNorthing);
};

struct Point {
    // Values are in the source/target CRS axis order. Geographic angular
    // units are given by Crs::angularUnit; projected values are metres.
    double first = 0.0;
    double second = 0.0;
    double heightMeters = 0.0;

    // Per-point observation epoch. When absent the Transformer epoch is used.
    std::optional<double> epoch;
};

enum class Status {
    Ok,
    InvalidConfiguration,
    NonFiniteInput,
    NonFiniteEpoch,
    EpochOutOfRange,
    OutOfDomain,
    ProjectionError,
    DatumError,
    NumericError,
    RoundTripToleranceExceeded
};

[[nodiscard]] const char* statusMessage(Status status) noexcept;

struct PointResult {
    Status status = Status::Ok;
    double first = kUndefined;
    double second = kUndefined;
    double heightMeters = kUndefined;

    [[nodiscard]] bool ok() const noexcept { return status == Status::Ok; }
};

struct RoundTripReport {
    Status status = Status::Ok;
    double errorMeters = kUndefined;
    double toleranceMeters = kUndefined;
    bool withinTolerance = false;

    [[nodiscard]] bool ok() const noexcept {
        return status == Status::Ok && withinTolerance;
    }
};

class Transformer {
public:
    Transformer(Crs source, Crs target, double epoch = 2000.0);

    [[nodiscard]] const Crs& source() const noexcept { return source_; }
    [[nodiscard]] const Crs& target() const noexcept { return target_; }
    [[nodiscard]] double epoch() const noexcept { return epoch_; }
    [[nodiscard]] bool valid() const noexcept {
        return configurationError_.empty();
    }
    [[nodiscard]] const std::string& configurationError() const noexcept {
        return configurationError_;
    }

    // A failed point receives NaN outputs and a non-Ok status. No state is
    // shared between points, so a failure never affects another batch item.
    [[nodiscard]] PointResult transform(const Point& point) const;
    [[nodiscard]] std::vector<PointResult> transform(
        std::span<const Point> points) const;

    // Converts source -> target -> source and measures the ECEF chord error in
    // the source ellipsoid frame. The default tolerance is the sum of the two
    // CRS published bounds.
    [[nodiscard]] RoundTripReport verifyRoundTrip(const Point& point) const;
    [[nodiscard]] RoundTripReport verifyRoundTrip(
        const Point& point, double toleranceMeters) const;
    [[nodiscard]] std::vector<RoundTripReport> verifyRoundTrip(
        std::span<const Point> points) const;

private:
    [[nodiscard]] RoundTripReport verifyRoundTripImpl(
        const Transformer& reverse, const Point& point,
        double toleranceMeters) const;

    Crs source_;
    Crs target_;
    double epoch_ = 2000.0;
    std::string configurationError_;
};

// Internal CRS round trip: geographic -> ECEF -> geographic, or projected ->
// geographic -> projected. This isolates projection / geodetic round-trip
// error from datum transformation error.
[[nodiscard]] RoundTripReport verifyCrsRoundTrip(
    const Crs& crs, const Point& point, double epoch = 2000.0);
[[nodiscard]] RoundTripReport verifyCrsRoundTrip(
    const Crs& crs, const Point& point, double epoch,
    double toleranceMeters);

}  // namespace dataeng
