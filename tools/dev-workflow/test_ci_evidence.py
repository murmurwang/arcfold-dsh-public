from copy import deepcopy
import unittest

import ci_evidence as ci
from common import WorkflowError
from workflow import CI_STEPS, ci_review_record


class SplitCITests(unittest.TestCase):
    def jobs(self):
        return [{"id": i, "name": name, "head_sha": "a" * 40, "status": "completed", "conclusion": "success",
                 "html_url": "https://example.invalid/job/" + str(i),
                 "steps": [{"name": s, "conclusion": "success"} for s in steps]}
                for i, (name, steps) in enumerate(((ci.RUNTIME, [ci.VERIFY, ci.RUNTIME_STEP]),
                                                   (ci.WORKFLOW, [ci.VERIFY, ci.WORKFLOW_STEP]),
                                                   (ci.SUMMARY, [ci.SUMMARY_STEP])))]

    def test_actual_split_jobs_are_bound_to_the_same_commit(self):
        group = ci.select(self.jobs(), "a" * 40, CI_STEPS)
        self.assertEqual(group["layout"], "split-v1")
        lines = [f"{ci.RUNTIME}\t{ci.RUNTIME_STEP}\t2026-11-16T01:00:00Z ✔ real check (1.2ms)",
                 f"{ci.WORKFLOW}\t{ci.WORKFLOW_STEP}\t2026-11-16T01:00:00Z Ran 12 tests in 0.3s",
                 f"wrong job\t{ci.WORKFLOW_STEP}\t2026-11-16T01:00:00Z Ran 99 tests in 1s"]
        result = ci_review_record({"head": "a" * 40}, group, "\n".join(lines))
        self.assertEqual(len(result["jobs"]), 3)
        self.assertEqual(result["workflow_results"], ["Ran 12 tests in 0.3s"])

    def test_aggregate_success_never_hides_a_skipped_or_missing_required_job(self):
        for status in ("skipped", "failure", "cancelled", "neutral"):
            jobs = self.jobs()
            jobs[0]["conclusion"] = status
            with self.subTest(status=status), self.assertRaises(WorkflowError):
                ci.select(jobs, "a" * 40, CI_STEPS)
        for changed in (self.jobs()[1:], self.jobs()[:1] + self.jobs()[2:], self.jobs()[:-1]):
            with self.assertRaises(WorkflowError):
                ci.select(changed, "a" * 40, CI_STEPS)
        changed = self.jobs()
        changed[1]["head_sha"] = "b" * 40
        with self.assertRaisesRegex(WorkflowError, "源码"):
            ci.select(changed, "a" * 40, CI_STEPS)

    def test_old_real_jobs_keep_working_and_new_summary_cannot_impersonate_them(self):
        old = {"name": ci.SUMMARY, "conclusion": "success", "head_sha": "a" * 40, "status": "completed",
               "steps": [{"name": name, "conclusion": "success"} for name in CI_STEPS]}
        self.assertEqual(ci.select([old], "a" * 40, CI_STEPS), old)
        with self.assertRaises(WorkflowError):
            ci.select([old, {**old, "conclusion": "failure"}], "a" * 40, CI_STEPS)
        with self.assertRaises(WorkflowError):
            ci.select([self.jobs()[-1]], "a" * 40, CI_STEPS)
