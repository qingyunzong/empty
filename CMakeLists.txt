cmake_minimum_required(VERSION 3.20)
project(dict_compress CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(compress src/compress.cpp)
target_include_directories(compress PUBLIC src)
target_compile_options(compress PRIVATE -Wall -Wextra -Wpedantic)

add_executable(compress_cli src/main.cpp)
target_link_libraries(compress_cli PRIVATE compress)

enable_testing()
add_executable(compress_tests tests/test_compress.cpp)
target_link_libraries(compress_tests PRIVATE compress)
add_test(NAME compress_tests COMMAND compress_tests)
