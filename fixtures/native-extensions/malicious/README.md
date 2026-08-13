# Malicious native-extension fixtures

These entrypoints deliberately attempt undeclared network access, unavailable network access,
partial-grant writes, cross-vault reads, and path traversal. The conformance suite runs them through
the same public SDK context as the portable fixture and asserts typed failures before the fake port
is called. Stale bundle, authority-growth, revocation, safe-mode, teardown, and timeout fixtures are
constructed in the test because each needs a distinct bundle revision or lifecycle callback.
