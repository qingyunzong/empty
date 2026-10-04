cmake_minimum_required(VERSION 3.20)
project(intmesh VERSION 0.1 LANGUAGES CXX)

option(INTMESH_SANITIZE "Build tests with AddressSanitizer + UBSan" OFF)

add_library(intmesh src/mesh.cpp)
target_include_directories(intmesh PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(intmesh PUBLIC cxx_std_20)
set_target_properties(intmesh PROPERTIES CXX_EXTENSIONS OFF)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(intmesh PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

set(INTMESH_TESTS
    test_diagnostics
    test_normals
    test_incremental
    test_snapshot)

foreach(test_name IN LISTS INTMESH_TESTS)
  add_executable(${test_name} tests/${test_name}.cpp)
  target_link_libraries(${test_name} PRIVATE intmesh)
  target_include_directories(${test_name} PRIVATE tests)
  set_target_properties(${test_name} PROPERTIES CXX_EXTENSIONS OFF)
  if(INTMESH_SANITIZE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${test_name} PRIVATE -fsanitize=address,undefined
                                                -fno-omit-frame-pointer)
    target_link_options(${test_name} PRIVATE -fsanitize=address,undefined)
  endif()
  add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
