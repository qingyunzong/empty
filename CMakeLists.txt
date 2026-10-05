cmake_minimum_required(VERSION 3.20)
project(spatial_aabb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(spatial src/spatial.cpp)
target_include_directories(spatial PUBLIC include)
target_compile_options(spatial PRIVATE -Wall -Wextra)

find_package(Threads REQUIRED)

enable_testing()
foreach(t IN ITEMS rational ray_aabb tree_vs_scan snapshot concurrency)
    add_executable(test_${t} tests/test_${t}.cpp)
    target_include_directories(test_${t} PRIVATE tests)
    target_link_libraries(test_${t} PRIVATE spatial Threads::Threads)
    target_compile_options(test_${t} PRIVATE -Wall -Wextra)
    add_test(NAME ${t} COMMAND test_${t})
endforeach()
