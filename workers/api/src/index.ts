import { Hono } from 'hono';
import { ZodError } from 'zod';
import { accessMiddleware } from './middleware/access';
import { capturesRoutes } from './routes/captures';
import type { AppBindings } from './env';

const app = new Hono<AppBindings>();

// Public liveness probe.
app.get('/healthz', (c) => c.text('ok'));

// API surface — Access-gated, everything under /v1.
// (Static assets are already gated by Cloudflare Access at the zone edge;
// the Worker middleware here is belt-and-suspenders for the API layer only.)
app.use('/v1/*', accessMiddleware());
app.route('/v1/captures', capturesRoutes);

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: 'invalid request', issues: err.issues }, 400);
  }
  const status = (err as { status?: number }).status ?? 500;
  return c.json({ error: err.message }, status as 400 | 401 | 403 | 404 | 500);
});

// Everything else → static assets (the dashboard SPA). The assets binding is
// configured with not_found_handling: "single-page-application", so React
// Router paths like /jobs/:id fall back to index.html.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
