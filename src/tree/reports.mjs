import { canonicalJson, digest, fail, array, shape, text } from './contracts.mjs';
import { ReportService } from './items.mjs';

const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
export class LocalReports {
  constructor({ repository, resolveSource }) { this.repo = repository; this.resolveSource = resolveSource; }
  recordReview(output, { job, requestId }) {
    const id = digest(['review-only-report', job.id]);
    const roleName = job.role === 'verification' ? '检验' : '改进';
    const category = output.report ? Array.from(output.report.problem).slice(0, 120).join('') : `${roleName}报告`;
    const fingerprint = digest([job.role, job.id]);
    const evidenceRefs = unique(job.input.sources.map(source => source.ref));
    return this.repo.command('recordReviewOnlyReport', { requestId, expected: {}, input: { jobId: job.id, resultHash: digest(output), sourceRefs: evidenceRefs } },
      { kind: 'model', role: job.role, id: job.id }, () => {
        this.repo.save('tree_reports', { id, category, fingerprint, producerRole: job.trigger.producerRole ?? job.role, step: roleName,
          problem: output.report?.problem ?? '系统已生成一份待核查的报告。', evidenceRefs,
          whyUniversal: output.report?.whyUniversal ?? '这是模型的判断，尚未确认。',
          stopgapIds: [], suggestedFix: output.report?.suggestedFix ?? '查看报告详情和原始依据；报告不会自动改变已有内容或设置。',
          status: 'unhandled', exportAudit: [], reviewOutput: output, reviewJobId: job.id });
        return { reportId: id };
      }).result;
  }
  create(proposal, { job, requestId, evidenceRefs }) {
    const category = proposal.problem.trim(), fingerprint = digest([job.trigger.producerRole, category.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')]), id = digest(['report', fingerprint]);
    return this.repo.command('recordLocalReport', { requestId, expected: {}, input: { proposal, sourceRefs: evidenceRefs, jobId: job.id } }, { kind: 'model', role: 'improvement', id: job.id }, () => {
      const old = this.repo.get('tree_reports', id);
      this.repo.save('tree_reports', { ...old, id, category, fingerprint, producerRole: job.trigger.producerRole, step: proposal.step, problem: proposal.problem, evidenceRefs: unique([...(old?.evidenceRefs ?? []), ...evidenceRefs]), whyUniversal: proposal.whyUniversal,
        stopgapIds: old?.stopgapIds ?? [], suggestedFix: proposal.suggestedFix, status: old?.status ?? 'unhandled', exportAudit: old?.exportAudit ?? [],
        history: [...(old?.history ?? []), { jobId: job.id, diagnosis: job.validatedResult?.diagnosis ?? '', repairIds: job.input.repairs.map(r => r.id), stopgap: proposal.stopgap, at: this.repo.now() }] }, old?.revision ?? null);
      return { reportId: id };
    }).result;
  }
  preview(id, { includeEvidence = false, actor }) {
    if (actor?.kind !== 'user') fail('FORBIDDEN', 'Only the authenticated owner can preview reports', 403);
    return new ReportService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor }) }).preview(id, { includeEvidence });
  }
  export(command, actor) {
    if (actor?.kind !== 'user') fail('FORBIDDEN', 'Only an explicit owner action can export', 403);
    return this.repo.command('exportLocalReports', command, actor, () => {
      shape(command.input, ['reportIds', 'includeEvidence']); const ids = array(command.input.reportIds, 'reportIds', 100);
      if (!ids.length || new Set(ids).size !== ids.length || typeof command.input.includeEvidence !== 'boolean') fail('INVALID_FIELD', 'Choose distinct reports and whether evidence is included');
      const content = ids.map(id => { this.repo.requireExpected(command, 'tree_reports', id); return this.preview(id, { includeEvidence: command.input.includeEvidence, actor }); });
      const body = JSON.stringify({ format: 'arcfold.local-reports/v1', reports: content }, null, 2), artifactId = digest(['report-export', command.requestId]);
      for (const id of ids) { const r = this.repo.get('tree_reports', id); this.repo.save('tree_reports', { ...r, exportAudit: [...r.exportAudit, { requestId: command.requestId, artifactId, at: this.repo.now(), includeEvidence: command.input.includeEvidence, contentHash: digest(body) }] }, r.revision); }
      return { artifactId, filename: 'arcfold-reports-' + artifactId.slice(0, 12) + '.json', mimeType: 'application/json', content: body, contentHash: digest(body), includesEvidence: command.input.includeEvidence, sent: false };
    });
  }
  resolved({ fingerprints, releaseId, requestId }) {
    // Only B7's trusted installed-release manifest may call this. No browser or
    // model endpoint accepts a claim that a developer fix has been installed.
    text(releaseId, 'releaseId', 512); array(fingerprints, 'fingerprints', 1000);
    return this.repo.command('resolveInstalledReportFixes', { requestId, expected: {}, input: { fingerprints, releaseId } }, { kind: 'program', id: 'installed-release' }, () => {
      const withdrawn = [], protectedIds = [];
      for (const report of this.repo.list('tree_reports', r => fingerprints.includes(r.fingerprint))) {
        for (const id of report.stopgapIds) {
          const item = this.repo.get('tree_items', id), bundle = item?.activeVersion && this.repo.get('tree_supplements', digest(['supplement', id, item.activeVersion]));
          if (!item || item.lifecycle !== 'active' || !bundle?.universalStopgap || bundle.reportId !== report.id) continue;
          if (item.userProtected) { protectedIds.push(id); continue; }
          this.repo.save('tree_items', { ...item, lifecycle: 'withdrawn', withdrawalReason: 'installed_developer_fix', resolvedByRelease: releaseId }, item.revision); withdrawn.push(id);
          for (const exposure of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === id))) this.repo.save('tree_exposures', { ...exposure, revoked: true, invalidationReason: 'installed_developer_fix' }, exposure.revision);
        }
        this.repo.save('tree_reports', { ...report, status: 'accepted', resolvedByRelease: releaseId }, report.revision);
      }
      return { withdrawn, protectedIds, releaseId };
    });
  }
}
