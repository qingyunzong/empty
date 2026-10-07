# CMake generated Testfile for 
# Source directory: /home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace
# Build directory: /home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test([=[unit]=] "/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/build/simtests")
set_tests_properties([=[unit]=] PROPERTIES  _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/CMakeLists.txt;26;add_test;/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/CMakeLists.txt;0;")
add_test([=[cli_example]=] "/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/build/simtool" "/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/scenarios/example.txt" "--verify")
set_tests_properties([=[cli_example]=] PROPERTIES  PASS_REGULAR_EXPRESSION "VERIFY PASS" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/CMakeLists.txt;28;add_test;/home/delin/.local/share/gsb-workbench/artifacts/c2bf9066f5c44648ac8c63042e62f049/run/B/attempt-004/workspace/CMakeLists.txt;0;")
