import { useState, useSyncExternalStore } from 'react';
import Drawer from 'antd/es/drawer';
import { Link, NavLink, Outlet, useLocation, useMatch } from 'react-router-dom';
import { Icon } from '../shared/ui/Icon';
import { projectReviewsPath, useProjects } from '../features/projects/queries';

const sidebarMedia = window.matchMedia('(max-width: 800px)');
const subscribeSidebarMedia = (listener: () => void) => {
  sidebarMedia.addEventListener('change', listener);
  return () => sidebarMedia.removeEventListener('change', listener);
};

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const narrow = useSyncExternalStore(subscribeSidebarMedia, () => sidebarMedia.matches, () => false);
  const location = useLocation();
  const query = useProjects();
  const scopedRoute = useMatch('/projects/:projectId/*');
  const project = query.data?.projects.find(item => item.id === scopedRoute?.params.projectId);
  const historyPath = project ? projectReviewsPath(project.id) : '/reviews';
  const detail = /\/reviews\/.+/.test(location.pathname);
  const task = /\/tasks\/.+/.test(location.pathname);
  const sidebarOpen = narrow ? mobileSidebarOpen : !sidebarCollapsed;
  const closeMobileSidebar = () => setMobileSidebarOpen(false);
  const sidebar = (
    <>
      <div className="sidebar-heading">
        <Link className="brand" to="/projects" onClick={closeMobileSidebar}><Icon name="shield" size={20} /><span>MergeWarden</span></Link>
        {narrow ? <button className="icon-button" type="button" aria-label="关闭侧栏" onClick={closeMobileSidebar}><Icon name="close" size={18} /></button> : null}
      </div>
      <div className="sidebar-content">
        <nav className="sidebar-nav" aria-label="工作台页面">
          <NavLink to="/projects" end onClick={closeMobileSidebar}><Icon name="folder" size={18} /><span>所有项目</span></NavLink>
          {project ? <NavLink to={historyPath} end onClick={closeMobileSidebar}><Icon name="history" size={18} /><span>审查历史</span></NavLink> : null}
          {detail || task ? <NavLink to={`${location.pathname}${location.search}`} onClick={closeMobileSidebar}><Icon name="file" size={18} /><span>{task ? '当前任务' : '当前审查'}</span></NavLink> : null}
        </nav>
        <section className="sidebar-repository" aria-label="当前仓库">
          <div className="sidebar-section-label">项目</div>
          <nav className="sidebar-nav sidebar-projects" aria-label="项目选择">{query.data?.projects.map(item => <NavLink key={item.id} to={projectReviewsPath(item.id)} onClick={closeMobileSidebar} title={item.repositoryPath}><Icon name="repository" size={17} /><span>{item.name}</span></NavLink>)}</nav>
          {query.isPending ? <span className="sidebar-message">正在读取项目…</span> : query.isError ? <button className="sidebar-retry" type="button" onClick={() => { void query.refetch(); }}>项目读取失败，重试</button> : null}
          {project ? <div className="sidebar-workspaces"><span className="repository-path" title={project.repositoryPath}>{project.repositoryPath}</span><span className="sidebar-message">{project.workspaces.length} 个已登记目录</span></div> : null}
        </section>
      </div>
      <div className="sidebar-footer"><Icon name="code" size={17} /><span>本地工作台</span><span className="read-only-badge">审查只读</span></div>
    </>
  );

  return (
    <div className={`app-shell${!narrow && sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">跳至主内容</a>
      {narrow ? <Drawer className="sidebar-drawer" placement="left" size={275} open={mobileSidebarOpen} onClose={closeMobileSidebar} closable={false} destroyOnHidden styles={{ body: { padding: 0 } }} aria-label="工作台导航"><aside id="workbench-sidebar" className="sidebar sidebar-mobile">{sidebar}</aside></Drawer> : <aside id="workbench-sidebar" className="sidebar" aria-label="工作台导航" hidden={sidebarCollapsed}>{sidebar}</aside>}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-start">
            <button className="icon-button sidebar-toggle" type="button" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebarOpen} aria-controls="workbench-sidebar" onClick={() => narrow ? setMobileSidebarOpen(open => !open) : setSidebarCollapsed(collapsed => !collapsed)}><Icon name="panel" size={18} /></button>
            <div className="breadcrumbs"><Link to={project ? historyPath : '/projects'} title={project?.repositoryPath}>{project?.name ?? '工作台'}</Link><Icon name="chevron" size={12} /><span>{detail ? '审查详情' : task ? '任务状态' : project ? '审查历史' : '项目'}</span></div>
          </div>
          <span className="topbar-mode"><Icon name="shield" size={14} /><span>只读浏览</span></span>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
