import { useState } from 'react';
import Button from 'antd/es/button';
import type { ProjectDto } from '@mergewarden/contracts';
import { Link, useNavigate } from 'react-router-dom';
import { describeError } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/PageState';
import { Icon } from '../../shared/ui/Icon';
import { ProjectRegistration } from './ProjectRegistration';
import { projectReviewsPath, useProjects } from './queries';

export function ProjectsPage() {
  const query = useProjects();
  const navigate = useNavigate();
  const [registration, setRegistration] = useState<{ project?: ProjectDto } | null>(null);

  return (
    <>
      <div className="page-heading"><div><h1>项目</h1><p className="page-description">按项目汇总主目录与工作树的审查记录。</p></div><Button type="primary" onClick={() => setRegistration({})}>添加项目</Button></div>
      {query.isPending ? <LoadingState label="正在读取项目…" /> : query.isError ? <ErrorState title="项目读取失败" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} /> : <ul className="project-list">{query.data.projects.map(project => <li key={project.id} className="project-item">
        <div className="project-item-heading"><span className="project-icon"><Icon name="folder" size={22} /></span><div><Link className="project-title" to={projectReviewsPath(project.id)}>{project.name}<Icon name="chevron" size={15} /></Link><p className="project-path mono">{project.repositoryPath}</p></div><Button onClick={() => setRegistration({ project })}>登记工作树</Button></div>
        <div className="project-workspaces"><span className="muted">{project.workspaces.length} 个目录</span>{project.workspaces.map(workspace => <span className="workspace-chip" key={workspace.id} title={workspace.path}><Icon name={workspace.kind === 'primary' ? 'repository' : 'branch'} size={14} />{workspace.name}<span>{workspace.kind === 'primary' ? '主目录' : '工作树'}</span></span>)}</div>
      </li>)}</ul>}
      {registration ? <ProjectRegistration project={registration.project} onClose={() => setRegistration(null)} onRegistered={project => { setRegistration(null); navigate(projectReviewsPath(project.id)); }} /> : null}
    </>
  );
}
