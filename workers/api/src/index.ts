import { Hono } from 'hono';
import { ZodError } from 'zod';
import { accessMiddleware } from './middleware/access';
import { capturesRoutes } from './routes/captures';
import type { AppBindings } from './env';

const app = new Hono<AppBindings>();

app.get('/healthz', (c) => c.text('ok'));

app.use('*', accessMiddleware());
app.route('/v1/captures', capturesRoutes);

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: 'invalid request', issues: err.issues }, 400);
  }
  const status = (err as { status?: number }).status ?? 500;
  return c.json({ error: err.message }, status as 400 | 401 | 403 | 404 | 500);
});

export default app;
