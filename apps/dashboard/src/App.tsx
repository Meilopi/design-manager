import { Link, NavLink, Route, Routes } from 'react-router-dom';
import JobsPage from './pages/JobsPage';
import JobDetailPage from './pages/JobDetailPage';
import TriggerPage from './pages/TriggerPage';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">Design Manager</Link>
        <nav>
          <NavLink to="/" end>Jobs</NavLink>
          <NavLink to="/new">Trigger</NavLink>
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/new" element={<TriggerPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function NotFound() {
  return <p className="muted">Page not found. <Link to="/">Back to jobs</Link>.</p>;
}
