// Test-only readiness hook; no network requests are made by this fixture.
if (process.argv[1]?.endsWith('/src/host/host.ts')) {
  const original = process.stdin[Symbol.asyncIterator];
  process.stdin[Symbol.asyncIterator] = function () {
    process.stdout.write('STDIN_READY\n');
    return original.call(this);
  };
}
