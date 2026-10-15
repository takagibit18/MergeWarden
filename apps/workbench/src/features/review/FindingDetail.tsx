import type { FindingDto } from '@mergewarden/contracts';
import { SeverityTag } from '../../shared/ui/StatusTag';
import { EvidenceViewer } from '../evidence/EvidenceViewer';

export function FindingDetail({ projectId, finding, runId, evidenceIndex, onEvidenceSelect }: { projectId: string; finding: FindingDto; runId: string; evidenceIndex: number; onEvidenceSelect: (index: number) => void }) {
  return (
    <section className="surface finding-detail" aria-label="所选问题详情">
      <header className="finding-detail-header"><SeverityTag severity={finding.severity} /><span className="mono muted small">{finding.id}</span><h2>{finding.title}</h2></header>
      <dl className="claim-details"><div><dt>问题说明</dt><dd>{finding.claim}</dd></div><div><dt>触发条件</dt><dd>{finding.trigger}</dd></div><div><dt>可能影响</dt><dd>{finding.impact}</dd></div></dl>
      <EvidenceViewer projectId={projectId} runId={runId} finding={finding} index={evidenceIndex} onSelect={onEvidenceSelect} />
    </section>
  );
}
