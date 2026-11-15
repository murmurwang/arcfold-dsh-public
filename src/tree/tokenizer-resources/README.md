# Exact offline token measurement

The v3 mode requires an explicit absolute Python interpreter in
`goalTreeV3.tokenCounter.python`. The frozen wheel supports CPython >=3.10,
macOS 11 or later, arm64. This implementation was actually validated with
CPython 3.12.14 on this arm64 Mac. Linux support is deferred; unsupported
platforms fail closed. The old mode does not start this counter.

The package contains the official deepseek-recipe 0.2.0 wheel, V4.1 tokenizer,
MIT license and tokenizer notice. Exact URLs, original byte counts and SHA-256
hashes are in manifest.json. Nothing is fetched or installed at startup. The
Python interpreter and standard library are an explicit host prerequisite,
not bundled or silently installed. The engineering validation resource pins
the existing interpreter directory separately.

Startup verifies the resource hashes and extracts the audited wheel into the
private runtime dependency directory. The Python process uses isolated mode,
no user/site imports, a clean environment and a 30-second deadline. A missing
or incompatible interpreter, changed asset or failed count stops the request.
There is no character-ratio or network fallback.

The native patched DeepSeek adapter first serializes the complete request
(messages, system instructions, tools and protocol) with a capture-only
transport. The official Messages converter and V4.1 encoder count those same
bytes. Admission requires the exact cached measurement; experiment budget
reservations independently keep the conservative 1M input bound.

One local 30-second encoding timeout was observed in the B7 E01 test; the
unchanged rerun and broader regression passed. The failed measurement sent no
model request and was retained. This is not evidence that timeouts cannot
recur.
