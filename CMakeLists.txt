cmake_minimum_required(VERSION 3.16)
project(exact_convolution CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

add_executable(convolve src/main.cpp)
target_include_directories(convolve PRIVATE src)

enable_testing()

add_executable(test_convolution tests/test_convolution.cpp)
target_include_directories(test_convolution PRIVATE src)
add_test(NAME convolution COMMAND test_convolution)

add_executable(test_cli tests/test_cli.cpp)
target_include_directories(test_cli PRIVATE src)
target_compile_definitions(test_cli PRIVATE CONVOLVE_EXE="$<TARGET_FILE:convolve>")
add_test(NAME cli COMMAND test_cli)
