cmake_minimum_required(VERSION 3.20)
project(rex LANGUAGES CXX)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(rex INTERFACE)
target_include_directories(rex INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(rex INTERFACE cxx_std_20)

enable_testing()

foreach(t IN ITEMS parser semantics vm exhaustive)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE rex)
  target_compile_options(test_${t} PRIVATE -Wall -Wextra)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
