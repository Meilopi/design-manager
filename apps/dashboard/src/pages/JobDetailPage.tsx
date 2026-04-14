import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ARTIFACT_LABELS, artifactUrl, getJob, type JobDetail } from '../api';
import { StatusBadge } from './JobsPage';
import type { CaptureArtifact } from '@design-manager/shared';

const POLL_MS = 3_000;
const TERMINAL: ReadonlySet<JobDetail['status']> = new Set(['completed', 'failed']);
const ARTIFACT_KEYS: readonly CaptureArtifact[] = [
  'screenshot',
  'singleFile',
  'mhtml',
  'rendered',
  'meta',
  'readme',
];

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const j = await getJob(id);
        if (!alive) return;
        setJob(j);
        setError(null);
        if (!TERMINAL.has(j.status)) {
          timer = window.setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id]);

  if (!id) return <p className="error">Missing job id.</p>;
  if (error) return <p className="error">Failed to load job: {error}</p>;
  if (!job) return <p className="muted">Loading job…</p>;

  return (
    <section>
      <p className="muted"><Link to="/">← All jobs</Link></p>
      <div className="row-between">
        <h1 className="mono">{job.id}</h1>
        <StatusBadge status={job.status} />
      </div>

      <dl className="meta">
        <dt>Product</dt><dd>{job.product_id}</dd>
        <dt>User</dt><dd>{job.user_id}</dd>
        <dt>URL</dt><dd className="breakall">{job.url}</dd>
        <dt>Created</dt><dd>{new Date(job.created_at).toLocaleString()}</dd>
        <dt>Completed</dt><dd>{job.completed_at ? new Date(job.completed_at).toLocaleString() : '—'}</dd>
        <dt>Requested by</dt><dd className="mono">{job.requested_by_json}</dd>
        {job.error && <><dt>Error</dt><dd className="error">{job.error}</dd></>}
      </dl>

      {job.status === 'completed' && (
        <>
          <h2>Screenshot</h2>
          <img
            className="preview"
            src={artifactUrl(job.id, 'screenshot')}
            alt={`Screenshot for job ${job.id}`}
          />

          <h2>Artifacts</h2>
          <ul className="artifacts">
            {ARTIFACT_KEYS.map((a) => (
              <li key={a}>
                <a href={artifactUrl(job.id, a)} target="_blank" rel="noreferrer">
                  {ARTIFACT_LABELS[a]}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
