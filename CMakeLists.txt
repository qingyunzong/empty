cmake_minimum_required(VERSION 3.20)
project(spatial_index CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

find_package(Threads REQUIRED)

add_library(spatial INTERFACE)
target_include_directories(spatial INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(spatial INTERFACE cxx_std_20)
target_link_libraries(spatial INTERFACE Threads::Threads)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(spatial INTERFACE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

set(SPATIAL_TESTS
    aabb
    zero_volume
    snapshot
    reclamation
    model_crosscheck
    concurrent)

foreach(t IN LISTS SPATIAL_TESTS)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE spatial)
  target_include_directories(test_${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
