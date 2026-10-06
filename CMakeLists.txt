cmake_minimum_required(VERSION 3.16)
project(page_compressor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(page_compressor src/page_compressor.cpp)
target_include_directories(page_compressor PUBLIC include)
target_compile_options(page_compressor PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(page_compressor_tests tests/page_compressor_tests.cpp)
target_link_libraries(page_compressor_tests PRIVATE page_compressor)
target_compile_options(page_compressor_tests PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME page_compressor_tests COMMAND page_compressor_tests)
