cmake_minimum_required(VERSION 3.20)
project(spatial_aabb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(spatial INTERFACE)
target_include_directories(spatial INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(spatial INTERFACE -Wall -Wextra -Wpedantic)

enable_testing()
find_package(Threads REQUIRED)

foreach(name IN ITEMS test_rational test_ray test_tree_scan test_snapshot test_concurrent)
  add_executable(${name} tests/${name}.cpp)
  target_link_libraries(${name} PRIVATE spatial Threads::Threads)
  add_test(NAME ${name} COMMAND ${name})
endforeach()
