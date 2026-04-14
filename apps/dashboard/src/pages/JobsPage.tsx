import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listJobs, type JobSummary } from '../api';

const REFRESH_MS = 5_000;

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await listJobs();
        if (alive) {
          setJobs(next);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (error) return <ErrorPanel message={error} />;
  if (jobs === null) return <p className="muted">Loading jobs…</p>;
  if (jobs.length === 0) {
    return (
      <section>
        <h1>Captures</h1>
        <p className="muted">No captures yet. <Link to="/new">Trigger one</Link>.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="row-between">
        <h1>Captures</h1>
        <Link to="/new" className="btn">+ New capture</Link>
      </div>
      <table className="jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Product</th>
            <th>URL</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td><Link to={`/jobs/${j.id}`} className="mono">{j.id.slice(0, 8)}</Link></td>
              <td>{j.product_id}</td>
              <td className="ellipsis" title={j.url}>{j.url}</td>
              <td><StatusBadge status={j.status} /></td>
              <td className="muted">{new Date(j.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function StatusBadge({ status }: { status: JobSummary['status'] }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <section>
      <h1>Captures</h1>
      <p className="error">Failed to load jobs: {message}</p>
    </section>
  );
}
