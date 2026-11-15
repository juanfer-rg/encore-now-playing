// Minimal test harness for plain gjs (no dependencies).

let failures = 0;
let passes = 0;

export function test(name, fn) {
    try {
        fn();
        passes++;
        print(`  ok   ${name}`);
    } catch (e) {
        failures++;
        print(`  FAIL ${name}\n       ${e.message}`);
    }
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

export function done() {
    print(`${passes} passed, ${failures} failed`);
    if (failures > 0)
        imports.system.exit(1);
}
