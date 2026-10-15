import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import { WorkbenchTheme } from './app/WorkbenchTheme';
import './styles.css';

const queryClient = new QueryClient();
const container = document.getElementById('root');
if (!container) throw new Error('Workbench root element is missing');

createRoot(container).render(
  <StrictMode>
    <WorkbenchTheme>
      <QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>
    </WorkbenchTheme>
  </StrictMode>,
);
