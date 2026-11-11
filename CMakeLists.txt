cmake_minimum_required(VERSION 3.16)
project(dlks_q254 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

add_library(yuv420 STATIC src/yuv420_to_rgb.cpp)
target_include_directories(yuv420 PUBLIC include)

add_executable(test_yuv420_to_rgb tests/test_yuv420_to_rgb.cpp)
target_link_libraries(test_yuv420_to_rgb PRIVATE yuv420)

enable_testing()
add_test(NAME yuv420_to_rgb COMMAND test_yuv420_to_rgb)
