import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App.tsx';
import NotFoundRoute from './routes/not-found.tsx';
import ProjectMetricsRoute from './routes/project-metrics.tsx';
import ProjectSettingsRoute from './routes/project-settings.tsx';
import ProjectStatusRoute from './routes/project-status.tsx';
import RootRoute from './routes/root.tsx';
import { initTheme } from './lib/theme.ts';
import './styles/index.css';

// Before the first render, so a saved choice is applied before anything paints.
initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root.');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* `App` is the layout route: it owns the one `/api/v1/me` check and
            the footer, and hands both down to whichever screen below matches
            (`Outlet context`). `BrowserRouter`, not hash routing, because
            `static-frontend.ts` already falls back to `index.html` for any
            path Express does not otherwise own. */}
        <Route element={<App />}>
          <Route index element={<RootRoute />} />
          <Route path="projects/:projectId" element={<ProjectMetricsRoute />} />
          <Route path="projects/:projectId/status" element={<ProjectStatusRoute />} />
          <Route path="projects/:projectId/settings" element={<ProjectSettingsRoute />} />
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
