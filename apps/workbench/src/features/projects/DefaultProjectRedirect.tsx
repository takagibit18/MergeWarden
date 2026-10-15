import { Navigate, useLocation } from 'react-router-dom';
import { describeError } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/PageState';
import { useProjects } from './queries';

export function DefaultProjectRedirect() {
  const location = useLocation();
  const query = useProjects();
  if (query.isPending) return <LoadingState label="正在打开默认项目…" />;
  if (query.isError) return <ErrorState title="项目读取失败" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />;
  const suffix = location.pathname === '/' ? '/reviews' : location.pathname;
  return <Navigate to={`/projects/${query.data.defaultProjectId}${suffix}${location.search}`} replace />;
}
