cmake_minimum_required(VERSION 3.20)
project(audio_resample LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(resampler src/resampler.cpp)
target_include_directories(resampler PUBLIC include)
target_compile_options(resampler PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(test_resampler tests/test_resampler.cpp)
target_link_libraries(test_resampler PRIVATE resampler)
target_compile_options(test_resampler PRIVATE -Wall -Wextra -Wpedantic)

foreach(case quantize identity chunk_invariance zero_tail impulse_delay saturation guards)
    add_test(NAME ${case} COMMAND test_resampler ${case})
endforeach()
