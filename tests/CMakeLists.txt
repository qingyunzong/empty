add_executable(test_scheduler test_scheduler.cpp)
target_link_libraries(test_scheduler PRIVATE dlks_formal)
target_compile_options(test_scheduler PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME scheduler COMMAND test_scheduler)

add_executable(test_simulator test_simulator.cpp)
target_link_libraries(test_simulator PRIVATE dlks_formal)
target_compile_options(test_simulator PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME simulator COMMAND test_simulator)

add_executable(test_invariants test_invariants.cpp)
target_link_libraries(test_invariants PRIVATE dlks_formal)
target_compile_options(test_invariants PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME invariants COMMAND test_invariants)
