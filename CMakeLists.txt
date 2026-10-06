cmake_minimum_required(VERSION 3.20)
project(detreduce VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(detreduce INTERFACE)
target_include_directories(detreduce INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(detreduce INTERFACE -Wall -Wextra)

find_package(Threads REQUIRED)
target_link_libraries(detreduce INTERFACE Threads::Threads)

enable_testing()
foreach(t IN ITEMS bigint rational reduce)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE detreduce)
  target_include_directories(test_${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
