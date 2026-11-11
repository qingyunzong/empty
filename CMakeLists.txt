cmake_minimum_required(VERSION 3.16)
project(dlks_q249 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(rasterizer STATIC src/rasterizer.cpp)
target_include_directories(rasterizer PUBLIC include)
target_compile_options(rasterizer PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(test_rasterizer tests/test_rasterizer.cpp)
target_link_libraries(test_rasterizer PRIVATE rasterizer)
target_compile_options(test_rasterizer PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME rasterizer_tests COMMAND test_rasterizer)
