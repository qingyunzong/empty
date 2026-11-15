#pragma once

// Embeddable, dependency-free Protobuf schema migration library.
//
// Include this single umbrella header to get:
//   * descriptor model      -> descriptor.hpp
//   * wire codec            -> wire.hpp
//   * validated plans       -> migration.hpp
//   * runtime transform     -> transform.hpp
//   * round-trip verifier   -> roundtrip.hpp

#include "dataeng/descriptor.hpp"
#include "dataeng/migration.hpp"
#include "dataeng/roundtrip.hpp"
#include "dataeng/status.hpp"
#include "dataeng/transform.hpp"
#include "dataeng/wire.hpp"
