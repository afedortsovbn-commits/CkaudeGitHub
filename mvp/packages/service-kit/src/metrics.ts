import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export function createMetrics(service: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP-запросы',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Длительность HTTP-запросов',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  return { registry, httpRequests, httpDuration };
}
export type Metrics = ReturnType<typeof createMetrics>;
