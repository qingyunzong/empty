cmake_minimum_required(VERSION 3.20)
project(curvelib LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(curvelib INTERFACE)
target_include_directories(curvelib INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(curvelib INTERFACE -Wall -Wextra)

enable_testing()

foreach(name rational intersection incremental certificate enumeration)
  add_executable(test_${name} tests/test_${name}.cpp)
  target_link_libraries(test_${name} PRIVATE curvelib)
  target_include_directories(test_${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  add_test(NAME ${name} COMMAND test_${name})
endforeach()
