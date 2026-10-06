cmake_minimum_required(VERSION 3.20)
project(regx LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(regx
  src/parser.cpp
  src/eval.cpp
  src/compiler.cpp
  src/verifier.cpp
  src/vm.cpp
  src/bytecode.cpp
)
target_include_directories(regx PUBLIC include)
target_compile_options(regx PRIVATE -Wall -Wextra)

enable_testing()

foreach(t IN ITEMS parser eval vm exhaustive)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE regx)
  target_include_directories(test_${t} PRIVATE tests)
  target_compile_options(test_${t} PRIVATE -Wall -Wextra)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
