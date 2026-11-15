# Agent Note: Correct the default model in Desktop and local release instructions

Status: proposed
observed_in_version: 0.4.0
fixed_in: 0.4.1
user_verified: pending

## Source

The first follow-up workflow trial addresses the release documentation discrepancy found during the independent 0.4.0 review. See the published [local release guide](https://github.com/murmurwang/arcfold-dsh-public/blob/v0.4.0/docs/release-bundle.md#外部运行配置) and the description displayed by DSH for the 0.4.0 package. The [first candidate check](https://github.com/murmurwang/arcfold-dsh-public/actions/runs/43705947934) found that the version bump also changes the dependency-lock checksum pinned in a host test.

## Problem

The local release guide says the initial reply model is Astra, while plain initialization reads DeepSeek V4 Pro from `runtime/initial-policy.json`. The Desktop plugin description lists the supported models but leaves the setup default unspecified. This makes it hard to predict which model a fresh setup selects.

## Proposal

Correct the local guide to name DeepSeek V4 Pro with high reasoning. In the description shipped with the Desktop package, say that first setup selects DeepSeek V4 Pro when the DSH default model is unset. Ship the wording as 0.4.1 and record it in the changelog. Refresh the test's expected lockfile checksum after verifying that the dependency entries are identical.

## Expected outcome

Someone opening the plugin description knows what a fresh Desktop setup selects. Someone reading the local release guide sees the default used by plain initialization.

## Alternatives considered

Correcting the local guide alone would leave the installed plugin description unclear. Keeping only the list of supported models would leave the first-setup behavior unspecified.

## Acceptance criteria

- The packaged Desktop description names DeepSeek V4 Pro as the first-setup choice when the DSH default model is unset.
- The local release guide gives the plain initialization choice as `deepseek-official/deepseek-v4-pro/high`.
- The 0.4.1 changelog and package manifests agree, with DSH compatibility at 0.2.2-rc.1.
- The host contract test accepts the refreshed lockfile checksum, and the pinned dependency versions and file checksums stay identical.
- After an isolated package-name update and restart, the plugin detail shows the new sentence and the original conversation is readable.

## Risks

The description could mislead someone with an existing DSH default if the setup condition were omitted. Keep the condition in the packaged text and verify that text from the built archive. Compare lockfile entries before recalculating the expected checksum so an unintended dependency change is caught.
