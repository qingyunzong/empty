cmake_minimum_required(VERSION 3.20)
project(motion1d VERSION 1.0 LANGUAGES CXX)

add_library(motion INTERFACE)
target_include_directories(motion INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(motion INTERFACE cxx_std_20)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(motion INTERFACE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
add_subdirectory(tests)
