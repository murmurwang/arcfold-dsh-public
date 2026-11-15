# Agent Note: Verify the Desktop candidate from the repository's locked inputs

Status: proposed

## Problem

The original packaging draft covers installation and updates. Its desktop build cannot count a real message with the host's interpreter. Some existing offline checks also expect an old private host directory, an earlier interface layout, or release files absent from the GitHub checkout.

## Proposal

Build on the private repository's current main. Carry the approved offline counter runtime, the synthetic tests, and the runtime documents required by the package manifest. Resolve the host fixtures from the locked npm install, verify their bytes, and run the interface tests for the approved Desktop layout. Give the synthetic cross-session context check time to complete under concurrent test load. The attribution deadline is exercised by separate tests. Build both Desktop packages from the checked commit.

## Expected outcome

A clean checkout can run the same synthetic checks and reproduce the exact test packages. The proposal records the package, source and check identities for independent review. Older tests that load real historical records stay with their original local sources.

## Alternatives considered

- Copy the old development history. It contains historical artifacts unrelated to the first Desktop package.
- Ship the earlier successful installation build. That build fails before submitting a real message on the original Desktop host.

## Acceptance criteria

- Run all checked-in tests against the exact proposed tree and locked dependencies.
- Verify that the two versions of each built package match the copies already used for testing.
- Preserve the interface acceptance for search, edits, conflicts, report export and the approved layout.
- Record what requires another check before a production release, including a full install, conversation, update and reopen in the signed DSH interface.

## Risks

The compatibility scope is Apple silicon with DSH 0.2.2-rc.1. Local package and process checks cover synthetic dialogue. Real provider verification, production publication, and an externally enforced merge check need their own evidence.
