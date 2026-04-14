import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { captureRequestSchema, type AuthKind } from '@design-manager/shared';
import { triggerCapture } from '../api';

export default function TriggerPage() {
  const nav = useNavigate();
  const [productId, setProductId] = useState('');
  const [userId, setUserId] = useState('');
  const [url, setUrl] = useState('https://');
  const [width, setWidth] = useState(1440);
  const [height, setHeight] = useState(900);
  const [selector, setSelector] = useState('');
  const [quietMs, setQuietMs] = useState(750);
  const [authKind, setAuthKind] = useState<AuthKind>('impersonation');
  const [authValue, setAuthValue] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = captureRequestSchema.safeParse({
      productId,
      userId,
      url,
      viewport: { width, height },
      settle: {
        ...(selector ? { selector } : {}),
        ...(quietMs > 0 ? { mutationQuietMs: quietMs } : {}),
      },
      auth: { kind: authKind, value: authValue },
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
      return;
    }

    setSubmitting(true);
    try {
      const { jobId } = await triggerCapture(parsed.data);
      nav(`/jobs/${jobId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>Trigger a capture</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          <span>Product ID</span>
          <input required value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="billing-app" />
        </label>
        <label>
          <span>User ID</span>
          <input required value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_123" />
        </label>
        <label>
          <span>URL</span>
          <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="row">
          <label>
            <span>Viewport width</span>
            <input type="number" min={320} max={8192} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            <span>Viewport height</span>
            <input type="number" min={320} max={8192} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </label>
        </div>
        <label>
          <span>Wait for selector <em className="muted">(optional)</em></span>
          <input value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="#dashboard-ready" />
        </label>
        <label>
          <span>MutationObserver quiet window (ms)</span>
          <input type="number" min={0} max={30000} value={quietMs} onChange={(e) => setQuietMs(Number(e.target.value))} />
        </label>
        <fieldset>
          <legend>Auth</legend>
          <div className="row">
            <label>
              <span>Kind</span>
              <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)}>
                <option value="impersonation">impersonation (JWT)</option>
                <option value="session">session (cookie)</option>
              </select>
            </label>
          </div>
          <label>
            <span>Value</span>
            <textarea
              required
              rows={4}
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              placeholder={authKind === 'impersonation' ? 'eyJhbGciOi...' : 'session=abc123; Domain=app.example.com'}
            />
          </label>
        </fieldset>

        {error && <pre className="error pre-wrap">{error}</pre>}

        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Trigger capture'}
        </button>
      </form>
    </section>
  );
}
