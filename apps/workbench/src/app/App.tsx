import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import Button from 'antd/es/button';
import { Link } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { EmptyState, LoadingState } from '../shared/ui/PageState';
import { DefaultProjectRedirect } from '../features/projects/DefaultProjectRedirect';

const HistoryPage = lazy(() => import('../features/history/HistoryPage').then(module => ({ default: module.HistoryPage })));
const ReviewPage = lazy(() => import('../features/review/ReviewPage').then(module => ({ default: module.ReviewPage })));
const TaskPage = lazy(() => import('../features/review/TaskPage').then(module => ({ default: module.TaskPage })));
const ProjectsPage = lazy(() => import('../features/projects/ProjectsPage').then(module => ({ default: module.ProjectsPage })));

export function App() {
  return (
    <Suspense fallback={<LoadingState label="正在加载工作台页面…" />}><Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DefaultProjectRedirect />} />
        <Route path="reviews" element={<DefaultProjectRedirect />} />
        <Route path="reviews/:runId" element={<DefaultProjectRedirect />} />
        <Route path="tasks/:taskId" element={<DefaultProjectRedirect />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId/reviews" element={<HistoryPage />} />
        <Route path="projects/:projectId/reviews/:runId" element={<ReviewPage />} />
        <Route path="projects/:projectId/tasks/:taskId" element={<TaskPage />} />
        <Route path="*" element={<EmptyState title="页面不存在" description="可以回到项目列表继续浏览。" action={<Link to="/projects"><Button type="primary">查看项目</Button></Link>} />} />
      </Route>
    </Routes></Suspense>
  );
}
