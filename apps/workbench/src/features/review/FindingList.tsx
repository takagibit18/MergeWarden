import { Link } from 'react-router-dom';
import type { FindingDto } from '@mergewarden/contracts';
import { SeverityTag } from '../../shared/ui/StatusTag';
import { Icon } from '../../shared/ui/Icon';

export function FindingList({ findings, selectedId, search }: { findings: FindingDto[]; selectedId: string | undefined; search: URLSearchParams }) {
  return (
    <section className="surface finding-list" aria-label="审查问题列表">
      <div className="section-heading"><h2>审查问题 <span className="section-count">{findings.length}</span></h2></div>
      <div className="finding-items">
        {findings.map((finding, index) => {
          const params = new URLSearchParams(search);
          params.set('finding', finding.id);
          params.delete('evidence');
          return (
            <Link className={`finding-item${selectedId === finding.id ? ' is-selected' : ''}`} key={finding.id} to={`?${params}`} aria-current={selectedId === finding.id ? 'true' : undefined}>
              <div className="finding-item-meta"><span className="finding-number">{String(index + 1).padStart(2, '0')}</span><SeverityTag severity={finding.severity} /></div>
              <h3>{finding.title}</h3>
              <p>{finding.claim}</p>
              <div className="finding-item-footer"><span><Icon name="code" size={14} />{finding.evidence.length} 处源码证据</span><Icon name="chevron" size={15} /></div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
