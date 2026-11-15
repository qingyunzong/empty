#include "dataeng.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace {

int gChecks = 0;
int gFailures = 0;

void check(bool condition, const char* expression, const char* file,
           int line, const std::string& detail = {}) {
    ++gChecks;
    if (condition) {
        return;
    }
    ++gFailures;
    std::fprintf(stderr, "%s:%d: check failed: %s%s%s\n", file, line,
                 expression, detail.empty() ? "" : " | ",
                 detail.c_str());
}

void checkNear(double actual, double expected, double tolerance,
               const char* expression, const char* file, int line) {
    ++gChecks;
    const bool condition =
        std::isfinite(actual) && std::isfinite(expected) &&
        std::abs(actual - expected) <= tolerance;
    if (condition) {
        return;
    }
    ++gFailures;
    std::fprintf(stderr,
                 "%s:%d: check failed: %s (actual %.17g, expected %.17g, "
                 "tolerance %.3g)\n",
                 file, line, expression, actual, expected, tolerance);
}

#define CHECK(expression) \
    check((expression), #expression, __FILE__, __LINE__)
#define CHECK_NEAR(actual, expected, tolerance) \
    checkNear((actual), (expected), (tolerance), #actual, __FILE__, __LINE__)

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kDegToRad = kPi / 180.0;

bool isNan(double value) {
    return std::isnan(value);
}

void testAxisOrderAndUnits() {
    const dataeng::Crs latitudeLongitude =
        dataeng::Crs::wgs84(dataeng::AxisOrder::LatitudeLongitude);
    const dataeng::Crs longitudeLatitude =
        dataeng::Crs::wgs84(dataeng::AxisOrder::LongitudeLatitude);
    const dataeng::Transformer transformer(latitudeLongitude,
                                           longitudeLatitude);
    CHECK(transformer.valid());

    const dataeng::PointResult result =
        transformer.transform(dataeng::Point{45.0, 10.0, 12.5});
    CHECK(result.ok());
    CHECK_NEAR(result.first, 10.0, 1.0e-12);
    CHECK_NEAR(result.second, 45.0, 1.0e-12);
    CHECK_NEAR(result.heightMeters, 12.5, 1.0e-6);

    const dataeng::Transformer reverse(longitudeLatitude,
                                       latitudeLongitude);
    const dataeng::PointResult reversed =
        reverse.transform(dataeng::Point{10.0, 45.0, 12.5});
    CHECK(reversed.ok());
    CHECK_NEAR(reversed.first, 45.0, 1.0e-12);
    CHECK_NEAR(reversed.second, 10.0, 1.0e-12);
    CHECK_NEAR(reversed.heightMeters, 12.5, 1.0e-6);

    dataeng::Crs radians =
        dataeng::Crs::wgs84(dataeng::AxisOrder::LatitudeLongitude);
    radians.angularUnit = dataeng::AngularUnit::Radians;
    const dataeng::Transformer radianTransformer(radians,
                                                 longitudeLatitude);
    const dataeng::PointResult fromRadians = radianTransformer.transform(
        dataeng::Point{30.0 * kDegToRad, 60.0 * kDegToRad, 0.0});
    CHECK(fromRadians.ok());
    CHECK_NEAR(fromRadians.first, 60.0, 1.0e-12);
    CHECK_NEAR(fromRadians.second, 30.0, 1.0e-12);
}

void testUtmKnownValues() {
    const dataeng::Crs wgs84 = dataeng::Crs::wgs84();
    const dataeng::Crs utm31 = dataeng::Crs::utm(31, true);
    const dataeng::Transformer transformer(wgs84, utm31);
    CHECK(transformer.valid());

    const dataeng::PointResult equator =
        transformer.transform(dataeng::Point{3.0, 0.0, 0.0});
    CHECK(equator.ok());
    CHECK_NEAR(equator.first, 500000.0, 1.0e-7);
    CHECK_NEAR(equator.second, 0.0, 1.0e-7);
    CHECK_NEAR(equator.heightMeters, 0.0, 1.0e-6);

    const dataeng::PointResult midLatitude =
        transformer.transform(dataeng::Point{3.0, 45.0, 0.0});
    CHECK(midLatitude.ok());
    CHECK_NEAR(midLatitude.first, 500000.0, 1.0e-6);
    CHECK_NEAR(midLatitude.second, 4982950.400226577, 1.0e-6);
    CHECK_NEAR(midLatitude.heightMeters, 0.0, 1.0e-6);

    const dataeng::Crs utm31South = dataeng::Crs::utm(31, false);
    const dataeng::Transformer southern(wgs84, utm31South);
    const dataeng::PointResult south =
        southern.transform(dataeng::Point{3.0, -45.0, 0.0});
    CHECK(south.ok());
    CHECK_NEAR(south.first, 500000.0, 1.0e-6);
    CHECK_NEAR(south.second, 5017049.599773423, 1.0e-6);

    const dataeng::Crs northingEasting =
        dataeng::Crs::utm(31, true, dataeng::AxisOrder::NorthingEasting);
    const dataeng::Transformer swapped(wgs84, northingEasting);
    const dataeng::PointResult swappedResult =
        swapped.transform(dataeng::Point{3.0, 45.0, 0.0});
    CHECK(swappedResult.ok());
    CHECK_NEAR(swappedResult.first, 4982950.400226577, 1.0e-6);
    CHECK_NEAR(swappedResult.second, 500000.0, 1.0e-6);

    const dataeng::Transformer swappedBack(northingEasting, wgs84);
    const dataeng::PointResult back = swappedBack.transform(
        dataeng::Point{swappedResult.first, swappedResult.second,
                       swappedResult.heightMeters});
    CHECK(back.ok());
    CHECK_NEAR(back.first, 3.0, 1.0e-10);
    CHECK_NEAR(back.second, 45.0, 1.0e-10);
}

void testWebMercatorKnownValues() {
    const dataeng::Crs wgs84 = dataeng::Crs::wgs84();
    const dataeng::Crs web = dataeng::Crs::webMercator();
    const dataeng::Transformer transformer(wgs84, web);

    const dataeng::PointResult origin =
        transformer.transform(dataeng::Point{0.0, 0.0, 0.0});
    CHECK(origin.ok());
    CHECK_NEAR(origin.first, 0.0, 1.0e-9);
    CHECK_NEAR(origin.second, 0.0, 1.0e-9);

    const dataeng::PointResult antimeridian =
        transformer.transform(dataeng::Point{180.0, 0.0, 0.0});
    CHECK(antimeridian.ok());
    CHECK_NEAR(antimeridian.first, 20037508.342789244, 1.0e-6);
    CHECK_NEAR(antimeridian.second, 0.0, 1.0e-6);

    const dataeng::PointResult latitude45 =
        transformer.transform(dataeng::Point{0.0, 45.0, 0.0});
    CHECK(latitude45.ok());
    CHECK_NEAR(latitude45.first, 0.0, 1.0e-9);
    CHECK_NEAR(latitude45.second, 5621521.486192066, 1.0e-6);

    const dataeng::PointResult tooFarNorth =
        transformer.transform(dataeng::Point{0.0, 86.0, 0.0});
    CHECK(tooFarNorth.status == dataeng::Status::OutOfDomain);
    CHECK(isNan(tooFarNorth.first));
    CHECK(isNan(tooFarNorth.second));
    CHECK(isNan(tooFarNorth.heightMeters));
}

void testTransverseMercatorOrigin() {
    dataeng::Crs custom = dataeng::Crs::wgs84();
    custom.kind = dataeng::CrsKind::Projected;
    custom.axisOrder = dataeng::AxisOrder::EastingNorthing;
    custom.projection = dataeng::Projection{
        dataeng::ProjectionType::TransverseMercator, -2.0, 49.0,
        0.9996012717, 400000.0, -100000.0};
    custom.domain.minLatitudeDegrees = 49.0;
    custom.domain.maxLatitudeDegrees = 61.0;
    custom.domain.minLongitudeDegrees = -9.0;
    custom.domain.maxLongitudeDegrees = 2.0;
    custom.domain.maxCentralMeridianOffsetDegrees = 9.0;

    CHECK(custom.valid());
    const dataeng::Transformer transformer(dataeng::Crs::wgs84(), custom);
    const dataeng::PointResult origin =
        transformer.transform(dataeng::Point{-2.0, 49.0, 0.0});
    CHECK(origin.ok());
    CHECK_NEAR(origin.first, 400000.0, 1.0e-7);
    CHECK_NEAR(origin.second, -100000.0, 1.0e-7);

    const dataeng::RoundTripReport report =
        dataeng::verifyCrsRoundTrip(custom,
                                    dataeng::Point{400000.0, -100000.0,
                                                   0.0});
    CHECK(report.ok());
    CHECK(report.errorMeters < 1.0e-5);
}

void testDatumTransforms() {
    dataeng::Crs source = dataeng::Crs::wgs84();
    source.datum.hasTransformToWgs84 = true;
    source.datum.referenceEpoch = 2000.0;
    source.datum.transformToWgs84.txMeters = 100.0;
    source.datum.ratesPerYear.txMeters = 1.0;
    source.datum.minEpoch = 2000.0;
    source.datum.maxEpoch = 2030.0;

    const dataeng::Crs target = dataeng::Crs::wgs84();
    const dataeng::Transformer transformer(source, target, 2000.0);
    CHECK(transformer.valid());

    const dataeng::PointResult epoch2000 =
        transformer.transform(dataeng::Point{0.0, 0.0, 0.0, 2000.0});
    CHECK(epoch2000.ok());
    CHECK_NEAR(epoch2000.first, 0.0, 1.0e-12);
    CHECK_NEAR(epoch2000.second, 0.0, 1.0e-12);
    CHECK_NEAR(epoch2000.heightMeters, 100.0, 1.0e-6);

    const dataeng::PointResult epoch2020 =
        transformer.transform(dataeng::Point{0.0, 0.0, 0.0, 2020.0});
    CHECK(epoch2020.ok());
    CHECK_NEAR(epoch2020.heightMeters, 120.0, 1.0e-6);

    const dataeng::PointResult outsideEpoch =
        transformer.transform(dataeng::Point{0.0, 0.0, 0.0, 2031.0});
    CHECK(outsideEpoch.status == dataeng::Status::EpochOutOfRange);
    CHECK(isNan(outsideEpoch.first));

    dataeng::Crs targetShifted = dataeng::Crs::wgs84();
    targetShifted.datum.hasTransformToWgs84 = true;
    targetShifted.datum.transformToWgs84.txMeters = 50.0;
    const dataeng::Transformer both(source, targetShifted, 2000.0);
    const dataeng::PointResult relative =
        both.transform(dataeng::Point{0.0, 0.0, 0.0});
    CHECK(relative.ok());
    CHECK_NEAR(relative.heightMeters, 50.0, 1.0e-6);

    dataeng::Crs rotated = dataeng::Crs::wgs84();
    rotated.datum.hasTransformToWgs84 = true;
    rotated.datum.transformToWgs84 = {10.0,  -20.0, 30.0, 1.0,
                                      -2.0,  3.0,   4.0};
    const dataeng::Transformer rotation(rotated, dataeng::Crs::wgs84());
    const dataeng::Point point{12.0, 34.0, 100.0};
    const dataeng::PointResult rotatedResult = rotation.transform(point);
    CHECK(rotatedResult.ok());
    const dataeng::RoundTripReport report =
        rotation.verifyRoundTrip(point);
    CHECK(report.ok());
    CHECK(report.errorMeters < 1.0e-5);
}

void testBatchIsolation() {
    dataeng::Crs latitudeLongitude =
        dataeng::Crs::wgs84(dataeng::AxisOrder::LatitudeLongitude);
    const dataeng::Crs longitudeLatitude = dataeng::Crs::wgs84();
    const dataeng::Transformer transformer(latitudeLongitude,
                                           longitudeLatitude);

    const std::vector<dataeng::Point> points{
        {10.0, 20.0, 0.0},
        {91.0, 20.0, 0.0},
        {30.0, 40.0, 5.0},
        {30.0, 400.0, 0.0},
        {50.0, 60.0, 0.0},
        {std::nan(""), 0.0, 0.0},
        {20.0, 10.0, 0.0, 2020.0}};

    const std::vector<dataeng::PointResult> results =
        transformer.transform(points);
    CHECK(results.size() == points.size());
    CHECK(results[0].ok());
    CHECK(results[1].status == dataeng::Status::OutOfDomain);
    CHECK(results[2].ok());
    CHECK(results[3].status == dataeng::Status::OutOfDomain);
    CHECK(results[4].ok());
    CHECK(results[5].status == dataeng::Status::NonFiniteInput);
    CHECK(results[6].ok());

    for (std::size_t index : {std::size_t{1}, std::size_t{3},
                              std::size_t{5}}) {
        CHECK(isNan(results[index].first));
        CHECK(isNan(results[index].second));
        CHECK(isNan(results[index].heightMeters));
    }

    for (std::size_t index : {std::size_t{0}, std::size_t{2},
                              std::size_t{4}, std::size_t{6}}) {
        const dataeng::PointResult single =
            transformer.transform(points[index]);
        CHECK(single.status == results[index].status);
        CHECK_NEAR(results[index].first, single.first, 0.0);
        CHECK_NEAR(results[index].second, single.second, 0.0);
        CHECK_NEAR(results[index].heightMeters, single.heightMeters,
                   0.0);
    }
}

void testDomainBehaviour() {
    const dataeng::Crs wgs84 = dataeng::Crs::wgs84();
    const dataeng::Crs utm31 = dataeng::Crs::utm(31, true);
    const dataeng::Transformer transformer(wgs84, utm31);

    CHECK(transformer.transform(dataeng::Point{181.0, 0.0, 0.0}).status ==
          dataeng::Status::OutOfDomain);
    CHECK(transformer.transform(dataeng::Point{0.0, 91.0, 0.0}).status ==
          dataeng::Status::OutOfDomain);
    CHECK(transformer.transform(dataeng::Point{90.0, 0.0, 0.0}).status ==
          dataeng::Status::OutOfDomain);
    CHECK(transformer.transform(dataeng::Point{0.0, 0.0, 2.0e8}).status ==
          dataeng::Status::OutOfDomain);

    dataeng::Crs wrapped = dataeng::Crs::wgs84();
    wrapped.domain.minLongitudeDegrees = 0.0;
    wrapped.domain.maxLongitudeDegrees = 360.0;
    const dataeng::Transformer toWrapped(wgs84, wrapped);
    const dataeng::PointResult result =
        toWrapped.transform(dataeng::Point{-10.0, 20.0, 0.0});
    CHECK(result.ok());
    CHECK_NEAR(result.first, 350.0, 1.0e-12);
    CHECK_NEAR(result.second, 20.0, 1.0e-12);

    const dataeng::RoundTripReport report =
        toWrapped.verifyRoundTrip(dataeng::Point{-10.0, 20.0, 0.0});
    CHECK(report.ok());
}

void testProjectedBatchIsolation() {
    const dataeng::Crs wgs84 = dataeng::Crs::wgs84();
    const dataeng::Crs utm31 = dataeng::Crs::utm(31, true);
    const dataeng::Transformer fromUtm(utm31, wgs84);

    const std::vector<dataeng::Point> projectedPoints{
        {500000.0, 0.0, 0.0},
        {1.0e12, 1.0e12, 0.0},
        {500000.0, 5000000.0, 0.0},
        {std::nan(""), 0.0, 0.0},
        {400000.0, 4000000.0, 0.0}};
    const auto projectedResults = fromUtm.transform(projectedPoints);
    CHECK(projectedResults[0].ok());
    CHECK(projectedResults[1].status != dataeng::Status::Ok);
    CHECK(projectedResults[2].ok());
    CHECK(projectedResults[3].status == dataeng::Status::NonFiniteInput);
    CHECK(projectedResults[4].ok());
    CHECK(isNan(projectedResults[1].first));
    CHECK(isNan(projectedResults[3].second));
    CHECK(projectedResults[0].first != 0.0);
    CHECK(projectedResults[2].first != 0.0);
    CHECK(projectedResults[4].first != 0.0);

    const dataeng::Crs web = dataeng::Crs::webMercator();
    const dataeng::Transformer toWeb(wgs84, web);
    const std::vector<dataeng::Point> geographicPoints{
        {0.0, 0.0, 0.0},  {0.0, 86.0, 0.0},
        {10.0, 45.0, 0.0}, {0.0, -86.0, 0.0},
        {20.0, -45.0, 0.0}};
    const auto webResults = toWeb.transform(geographicPoints);
    CHECK(webResults[0].ok());
    CHECK(webResults[1].status == dataeng::Status::OutOfDomain);
    CHECK(webResults[2].ok());
    CHECK(webResults[3].status == dataeng::Status::OutOfDomain);
    CHECK(webResults[4].ok());
    CHECK(isNan(webResults[1].first));
    CHECK(isNan(webResults[3].first));
    CHECK_NEAR(webResults[0].first,
               toWeb.transform(geographicPoints[0]).first, 0.0);
    CHECK_NEAR(webResults[2].first,
               toWeb.transform(geographicPoints[2]).first, 0.0);
    CHECK_NEAR(webResults[4].first,
               toWeb.transform(geographicPoints[4]).first, 0.0);
}

void testRoundTripVerification() {
    const dataeng::Crs wgs84 = dataeng::Crs::wgs84();
    const dataeng::Crs utm31 = dataeng::Crs::utm(31, true);
    const dataeng::Transformer transformer(wgs84, utm31);

    const std::vector<dataeng::Point> points{
        {3.0, 0.0, 0.0},   {3.0, 30.0, 0.0},  {3.0, 45.0, 100.0},
        {0.2, 60.0, 0.0},  {5.8, 75.0, 0.0},  {3.0, 83.0, 0.0}};
    const std::vector<dataeng::RoundTripReport> reports =
        transformer.verifyRoundTrip(points);
    CHECK(reports.size() == points.size());
    for (const dataeng::RoundTripReport& report : reports) {
        CHECK(report.ok());
        CHECK(report.errorMeters <= report.toleranceMeters);
        CHECK(report.errorMeters < 1.0e-5);
    }

    const dataeng::RoundTripReport tight =
        transformer.verifyRoundTrip(dataeng::Point{4.0, 45.0, 0.0},
                                    1.0e-12);
    CHECK(tight.status ==
          dataeng::Status::RoundTripToleranceExceeded);
    CHECK(!tight.withinTolerance);
    CHECK(tight.errorMeters > 1.0e-12);

    const dataeng::RoundTripReport invalid =
        transformer.verifyRoundTrip(dataeng::Point{90.0, 45.0, 0.0});
    CHECK(invalid.status == dataeng::Status::OutOfDomain);
    CHECK(!invalid.ok());

    const dataeng::RoundTripReport geographic =
        dataeng::verifyCrsRoundTrip(wgs84,
                                    dataeng::Point{34.0, 12.0, 100.0});
    CHECK(geographic.ok());
    CHECK(geographic.errorMeters <= geographic.toleranceMeters);

    dataeng::Crs sphere = dataeng::Crs::wgs84();
    sphere.datum.ellipsoid = dataeng::Ellipsoid{6371000.0, 0.0};
    const dataeng::RoundTripReport spherical =
        dataeng::verifyCrsRoundTrip(sphere,
                                    dataeng::Point{34.0, 12.0, 100.0});
    CHECK(spherical.ok());

    const dataeng::RoundTripReport projected =
        dataeng::verifyCrsRoundTrip(
            utm31, dataeng::Point{500000.0, 5000000.0, 0.0});
    CHECK(projected.ok());
    CHECK(projected.errorMeters <= projected.toleranceMeters);

    const dataeng::RoundTripReport projectedTight =
        dataeng::verifyCrsRoundTrip(
            utm31, dataeng::Point{480000.0, 5000000.0, 0.0}, 2000.0,
            1.0e-12);
    CHECK(projectedTight.status ==
          dataeng::Status::RoundTripToleranceExceeded);
}

void testDynamicBatchIsolation() {
    dataeng::Crs dynamic = dataeng::Crs::wgs84();
    dynamic.datum.hasTransformToWgs84 = true;
    dynamic.datum.referenceEpoch = 2000.0;
    dynamic.datum.transformToWgs84.txMeters = 25.0;
    dynamic.datum.ratesPerYear.txMeters = 0.5;
    dynamic.datum.minEpoch = 2000.0;
    dynamic.datum.maxEpoch = 2030.0;

    const dataeng::Transformer transformer(dynamic,
                                           dataeng::Crs::wgs84(), 2020.0);
    std::vector<dataeng::Point> points(3);
    points[0].first = 0.0;
    points[0].second = 0.0;
    points[0].epoch = 2020.0;
    points[1].first = 0.0;
    points[1].second = 0.0;
    points[1].epoch = 2035.0;
    points[2].first = 0.0;
    points[2].second = 0.0;

    const auto results = transformer.transform(points);
    CHECK(results[0].ok());
    CHECK(results[1].status == dataeng::Status::EpochOutOfRange);
    CHECK(results[2].ok());
    CHECK_NEAR(results[0].heightMeters, 35.0, 1.0e-6);
    CHECK_NEAR(results[2].heightMeters, 35.0, 1.0e-6);
    CHECK(isNan(results[1].first));

    const dataeng::RoundTripReport report =
        transformer.verifyRoundTrip(points[1]);
    CHECK(report.status == dataeng::Status::EpochOutOfRange);
}

void testConfigurationValidation() {
    dataeng::Crs badAxis = dataeng::Crs::wgs84();
    badAxis.axisOrder = dataeng::AxisOrder::EastingNorthing;
    std::string error;
    CHECK(!badAxis.valid(&error));
    CHECK(!error.empty());

    dataeng::Crs missingProjection;
    missingProjection.kind = dataeng::CrsKind::Projected;
    missingProjection.axisOrder = dataeng::AxisOrder::EastingNorthing;
    CHECK(!missingProjection.valid());

    dataeng::Crs badEllipsoid = dataeng::Crs::wgs84();
    badEllipsoid.datum.ellipsoid.inverseFlattening = 0.5;
    CHECK(!badEllipsoid.valid());

    dataeng::Crs badRates = dataeng::Crs::wgs84();
    badRates.datum.ratesPerYear.txMeters = 1.0;
    CHECK(!badRates.valid());

    const dataeng::Transformer transformer(badAxis,
                                           dataeng::Crs::wgs84());
    CHECK(!transformer.valid());
    CHECK(!transformer.configurationError().empty());
    const dataeng::PointResult result =
        transformer.transform(dataeng::Point{0.0, 0.0, 0.0});
    CHECK(result.status == dataeng::Status::InvalidConfiguration);
    CHECK(isNan(result.first));
}

}  // namespace

int main() {
    testAxisOrderAndUnits();
    testUtmKnownValues();
    testWebMercatorKnownValues();
    testTransverseMercatorOrigin();
    testDatumTransforms();
    testBatchIsolation();
    testProjectedBatchIsolation();
    testDomainBehaviour();
    testRoundTripVerification();
    testDynamicBatchIsolation();
    testConfigurationValidation();

    std::printf("%d checks, %d failures\n", gChecks, gFailures);
    return gFailures == 0 ? 0 : 1;
}
