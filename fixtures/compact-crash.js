// Opens the store and compacts. With BIOSPEC_CRASH_BEFORE_POINTER_SWITCH=1
// the process exits (simulated crash) after the new generation files are
// written but before the POINTER switch.
import { Store } from '../src/store.js';

const store = Store.open(process.argv[2]);
store.compact();
store.close();
