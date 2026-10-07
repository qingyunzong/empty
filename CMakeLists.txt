cmake_minimum_required(VERSION 3.20)
project(ammo_sim CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(ammo src/solver.cpp)
target_include_directories(ammo PUBLIC include)
target_compile_options(ammo PRIVATE -Wall -Wextra -Wpedantic)

add_executable(ammo_sim src/main.cpp)
target_link_libraries(ammo_sim PRIVATE ammo)

enable_testing()
add_executable(test_solver tests/test_solver.cpp)
target_link_libraries(test_solver PRIVATE ammo)

foreach(name IN ITEMS
    linear_basic
    nonlinear_synergy
    tie_break_ammo
    budget_limit
    unreachable_threshold
    zero_budget
    four_types
    cross_check_random
    cross_check_four_types)
  add_test(NAME ${name} COMMAND test_solver ${name})
endforeach()
