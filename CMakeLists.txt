cmake_minimum_required(VERSION 3.20)
project(tilelib LANGUAGES CXX)

add_library(tilelib src/tilelib.cpp)
target_include_directories(tilelib PUBLIC include)
target_compile_features(tilelib PUBLIC cxx_std_20)
set_target_properties(tilelib PROPERTIES CXX_EXTENSIONS OFF)
if(MSVC)
  target_compile_options(tilelib PRIVATE /W4)
else()
  target_compile_options(tilelib PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

add_executable(test_tilelib tests/test_tilelib.cpp)
target_link_libraries(test_tilelib PRIVATE tilelib)

set(TILELIB_TESTS
    viewport_requests
    late_result_old_version
    parent_substitute
    eviction_budget_conservation
    cancellation
    provenance)

foreach(test_name IN LISTS TILELIB_TESTS)
  add_test(NAME ${test_name} COMMAND test_tilelib ${test_name})
endforeach()
