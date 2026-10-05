cmake_minimum_required(VERSION 3.20)
project(pta LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(pta src/points_to.cpp)
target_include_directories(pta PUBLIC include)
target_compile_options(pta PRIVATE -Wall -Wextra)

enable_testing()
add_executable(test_pta tests/test_pta.cpp)
target_link_libraries(test_pta PRIVATE pta)

foreach(case basic fields fixpoint deletion)
  add_test(NAME ${case} COMMAND test_pta ${case})
endforeach()
