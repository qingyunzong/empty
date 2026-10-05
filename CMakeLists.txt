cmake_minimum_required(VERSION 3.20)
project(rational_resampler CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(rational_resampler src/rational_resampler.cpp)
target_include_directories(rational_resampler PUBLIC include)
target_compile_options(rational_resampler PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(resampler_tests tests/resampler_tests.cpp)
target_link_libraries(resampler_tests PRIVATE rational_resampler)
target_compile_options(resampler_tests PRIVATE -Wall -Wextra -Wpedantic)

foreach(case rounding saturation identity_delay chunked_vs_oneshot zero_tail dc)
  add_test(NAME ${case} COMMAND resampler_tests ${case})
endforeach()
