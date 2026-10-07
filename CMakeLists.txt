cmake_minimum_required(VERSION 3.20)
project(kmerge CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(kmerge INTERFACE)
target_include_directories(kmerge INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
if(MSVC)
  target_compile_options(kmerge INTERFACE /W4)
else()
  target_compile_options(kmerge INTERFACE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

foreach(test_name model_test pause_error_test cancel_test)
  add_executable(${test_name} tests/${test_name}.cpp)
  target_link_libraries(${test_name} PRIVATE kmerge)
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
