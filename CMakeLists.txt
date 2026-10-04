cmake_minimum_required(VERSION 3.20)
project(curve2d CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON) # __int128

add_library(curve2d src/geometry.cpp src/library.cpp)
target_include_directories(curve2d PUBLIC include)
target_compile_options(curve2d PRIVATE -Wall -Wextra)

enable_testing()
foreach(t IN ITEMS rational intersect incremental enumerate certificate)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_include_directories(test_${t} PRIVATE tests)
  target_link_libraries(test_${t} PRIVATE curve2d)
  target_compile_options(test_${t} PRIVATE -Wall -Wextra)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
