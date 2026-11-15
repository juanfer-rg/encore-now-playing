// Minimal test harness for plain gjs (no dependencies). Tests may be async.

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function assertEqual(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg} expected ${e}, got ${a}`);
}

export function assert(cond, msg = 'assertion failed') {
    if (!cond)
        throw new Error(msg);
}

/** Run the registered tests in order and exit non-zero on failure. */
export async function done() {
    let passes = 0, failures = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            passes++;
            print(`  ok   ${name}`);
        } catch (e) {
            failures++;
            print(`  FAIL ${name}\n       ${e.message}`);
        }
    }
    print(`${passes} passed, ${failures} failed`);
    if (failures > 0)
        imports.system.exit(1);
}
