# Agent Note: Correct the default model and attach the release check evidence

Status: proposed
observed_in_version: 0.4.0
fixed_in: 0.4.1
user_verified: pending

## Source

The independent 0.4.0 review found an inconsistency in the published [local release guide](https://github.com/murmurwang/arcfold-dsh-public/blob/v0.4.0/docs/release-bundle.md#外部运行配置) and the plugin description displayed by DSH. The [first candidate check](https://github.com/murmurwang/arcfold-dsh-public/actions/runs/43705947934) showed that the version bump changes the packaged host test's expected lockfile checksum. The [review of the corrected candidate](https://github.com/murmurwang/arcfold-dsh-public/pull/2#issuecomment-6893530868) confirmed the GitHub run matched the commit and reported that it could not see the actual test results or per-entry lockfile comparison.

## Problem

The local guide says the initial reply model is Astra. Plain initialization uses DeepSeek V4 Pro from `runtime/initial-policy.json`. The installed Desktop description lists supported models and leaves the first-setup choice unspecified. Separately, the review packet contains the run and commit and summarizes unchanged dependencies, but omits the job's test results and individual checksums, leaving the reviewer unable to confirm release checks.

## Proposal

Correct the local guide and describe the Desktop default condition in the shipped description. Release the wording as 0.4.1, refresh the test's lockfile checksum, and record the changes in the changelog. Include the configured workflow, structured job metadata and recorded test results from the precise GitHub run and attempt in the independent review packet. When lock entries are identical, include the complete Git diff and the full before-and-after comparison of the entries.

## Expected outcome

Readers can tell which model a fresh setup selects. The independent review can match the actual tests and exact dependency comparison to the proposed release.

## Alternatives considered

Correcting only the local guide would leave the installed description unclear. Sharing full unfiltered GitHub logs would send unrelated diagnostics. Supplying a manual claim about tests would leave the reviewer without the results from the bound run.

## Acceptance criteria

- The packaged Desktop description says first setup selects DeepSeek V4 Pro when the DSH default model is unset.
- The local release guide gives the plain initialization choice as `deepseek-official/deepseek-v4-pro/high`.
- Both packages and the changelog identify 0.4.1 and DSH compatibility stays at 0.2.2-rc.1.
- The matching GitHub check ran on the candidate commit. The reviewer sees its actual Desktop packaging and host-test results, the job conclusions and skip counts.
- The review packet displays the complete lockfile diff and per-entry comparison of the 793 locked dependencies. Those entries and pinned host package file checksums agree across the versions.
- After an isolated package-name update and restart, the plugin detail shows the updated sentence and the original conversation is readable.

## Risks

The description needs the condition for users with a configured DSH default. Include only test outcomes from the designated steps and scan the extracted review material before submission. Keep the established CI, independent review and merge gates in force.
