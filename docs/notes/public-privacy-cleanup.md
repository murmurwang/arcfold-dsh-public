# Agent Note: Remove personal references from public source and check publication privacy

Status: proposed
observed_in_version: 0.4.0 and 0.4.1
fixed_in: pending
user_verified: pending

## Source

The project owner requested cleanup of local computer paths in public npm metadata and personal references in public source on 2026-11-15. The existing publisher email is explicitly accepted and must remain unchanged.

## Problem

Public project notes and workflow messages name one individual and disclose individual decisions where role-based language is sufficient. The source export check also fails to identify ordinary personal-provider email addresses because its pattern requires an extra domain component. Separately, publishing an archive by an absolute local path can add that path to registry metadata even when the archive itself is clean.

## Proposal

Use role-based wording in first-party notes, test limitations and workflow feedback. Keep the technical history, authority requirements, public repository links and third-party licenses unchanged. Correct the export email check and verify it with synthetic examples. Document publication metadata checks and verify the CLI's publication payload against a local fake registry without sending credentials or publishing packages. Registry cleanup remains a separate operation and must preserve package versions, integrity values, dependencies and installation access.

## Expected outcome

The candidate source no longer singles out an individual in project behavior or decision statements. The source export identifies ordinary personal-provider emails for manual review. The publication guidance covers data added outside the package archive. Existing public source history and npm metadata are not declared removed until separately verified.

## Alternatives considered

- Only editing package contents misses the local path fields added by the publishing client.
- Unpublishing existing versions removes installation access and cannot be undone; it is not part of this change.
- Rewriting public source history would change existing version references and requires its own explicit plan and coordination.

## Acceptance criteria

- First-party source outside the unmodified upstream tokenizer resources has no individual-specific references in project decisions, test limitations or workflow feedback.
- Technical decisions and authorization boundaries retain their meaning after neutral wording changes.
- The export check flags standard Gmail and Outlook address examples for review; ordinary project text and public repository links remain usable.
- Existing workflow checks and the focused export regression checks pass offline.
- The publication guidance distinguishes package archive content, client-added local paths, and server-added publisher email, and records that the publisher email is intentionally retained.
- No existing package version, dependency, distribution tag, archive, private local evidence, or daily installation is changed by this source proposal.

## Risks

This changes the current candidate source only. Prior GitHub commits and hosted npm records may still expose earlier data; platform-supported cleanup must be verified separately. Third-party dictionaries and copyright notices may contain unrelated names and are not edited. Paid independent review remains subject to its established estimate and authorization requirements.
