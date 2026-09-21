import { z } from 'zod';
import type { ZodType } from 'zod';
import { ingestBodySchema } from '../schemas/ingest.schemas.js';

/**
 * The OpenAPI 3.0 document served at `/openapi.json`.
 *
 * The request body comes from the same zod schema `middlewares/validate.ts`
 * enforces at runtime, so the published contract cannot drift from what the
 * endpoint accepts - same convention as
 * `applications/viewer/src/docs/openapi.ts`.
 */

function schema(zodSchema: ZodType): object {
  // Zod 4's own converter, NOT the third-party zod-to-json-schema package:
  // that package reads Zod 3-shaped internals and silently returns `{}` for a
  // native Zod 4 schema. See the viewer's openapi.ts for the same note.
  return z.toJSONSchema(zodSchema, { target: 'openapi-3.0' });
}

const errorResponse = {
  description: 'An error response, shared by every endpoint.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'ValidationError' },
          message: { type: 'string' },
          statusCode: { type: 'integer' },
          issues: {
            type: 'array',
            description: 'Present only on a 400 from the validation layer.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

export function buildOpenApiDocument(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'metrion ingest API',
      version: '0.1.0',
      description:
        'Accepts metrics from any application in any language over one authenticated ' +
        'HTTP endpoint - no SDK required. Tenancy is resolved entirely from the API key ' +
        '(see docs/adr/0005-api-key-determines-tenancy.md); nothing in the request body ' +
        'can change which project a row is written to.',
    },
    tags: [
      { name: 'ingest', description: 'Submitting metrics.' },
      { name: 'health', description: 'Liveness.' },
      { name: 'public-status', description: 'Unauthenticated public uptime.' },
    ],
    components: {
      securitySchemes: {
        apiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mtr_<prefix>_<secret>',
          description:
            'A project API key. Never published here - it is generated per project and ' +
            'revoked at `api_keys.revoked_at`.',
        },
      },
    },
    paths: {
      '/api/v1/health/liveness': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe. No database connection required.',
          responses: {
            '200': {
              description: 'The process is running.',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { status: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      '/api/v1/ingest': {
        post: {
          tags: ['ingest'],
          summary: 'Write one or more metric points.',
          description:
            'Accepts one metric envelope, an array of envelopes, or a bare array of metric ' +
            'points with no envelope at all - the resource for that last shape falls back to ' +
            "the authenticated project's default_resource. If the API key is bound to a " +
            "specific application, resource is forced to that application's own key for " +
            'every point and any resource named in the body is silently ignored. Rate ' +
            'limited per API key.',
          security: [{ apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema(ingestBodySchema) } },
          },
          responses: {
            '202': {
              description: 'Written.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      accepted: { type: 'integer' },
                      points: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '429': errorResponse,
          },
        },
      },
      '/api/v1/public/projects/{id}/uptime/range': {
        get: {
          tags: ['public-status'],
          summary: "A project's public uptime over an arbitrary date range, bucketed.",
          description:
            'No API key or session required; same public_status_enabled gate, 404 behaviour and ' +
            'shared rate limit as /uptime. `from`/`to` are ISO-8601 (with offset or Z) or a bare ' +
            'date; a bare `from` is 00:00:00Z of that day, a bare `to` is the END of that UTC day ' +
            '(inclusive). `to` later than now is clamped to now; `from` in the future, `from` >= ' +
            '`to` or `from` before 2000-01-01 is a 400. Both are floored to whole minutes. An ' +
            'absent `from` means the whole period (first UTC day with data); an absent `to` means ' +
            'now. A `from` before the first day with data is raised to it. Granularity is the ' +
            'smallest of 1m, 5m, 15m (ranges up to 7 days) or 1d (longer) that keeps the bucket ' +
            'count at or under 2000. Buckets are aligned to UTC and whole, so the first and last ' +
            'may reach outside [from, to). A bucket without samples has upPct null (before the ' +
            "monitor's first sample, or a data hole - never downtime). Only the 60 s vantage " +
            'counts. For 1d, latency is an approximation (flagged) and idlePct is null unless ' +
            'idle samples exist. Unknown query parameters are ignored.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'from', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'to', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description:
                'Per-application buckets, range aggregates and incidents. Cache-Control ' +
                'max-age is 60, or 3600 when the range ends before the start of today (UTC).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projectId: { type: 'string', format: 'uuid' },
                      generatedAt: { type: 'string', format: 'date-time' },
                      range: {
                        type: 'object',
                        properties: {
                          from: { type: 'string', format: 'date-time' },
                          to: { type: 'string', format: 'date-time' },
                          granularity: { type: 'string', enum: ['1m', '5m', '15m', '1d'] },
                          bucketCount: { type: 'integer' },
                        },
                      },
                      applications: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            key: { type: 'string' },
                            displayName: { type: 'string', nullable: true },
                            firstSampleAt: { type: 'string', format: 'date-time' },
                            lastSampleAt: { type: 'string', format: 'date-time' },
                            uptimePct: { type: 'number', nullable: true },
                            coverage: { type: 'number', nullable: true },
                            latency: {
                              type: 'object',
                              properties: {
                                p50: { type: 'number', nullable: true },
                                p95: { type: 'number', nullable: true },
                                approximate: { type: 'boolean' },
                              },
                            },
                            idlePct: { type: 'number', nullable: true },
                            buckets: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  t: { type: 'string', format: 'date-time' },
                                  upPct: { type: 'number', nullable: true },
                                  samples: { type: 'integer' },
                                },
                              },
                            },
                            incidents: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  startedAt: { type: 'string', format: 'date-time' },
                                  endedAt: { type: 'string', format: 'date-time', nullable: true },
                                  durationSeconds: { type: 'integer' },
                                  downSamples: { type: 'integer' },
                                },
                              },
                            },
                            truncated: { type: 'boolean' },
                            totalIncidents: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '404': errorResponse,
            '429': errorResponse,
          },
        },
      },
      '/api/v1/public/projects/{id}/uptime': {
        get: {
          tags: ['public-status'],
          summary: "A project's public uptime, if it opted in.",
          description:
            'No API key or session required. Answers 404 for a nonexistent project id, a ' +
            'malformed id, and an existing project with public_status_enabled=false - the same ' +
            'response for all three, so no caller can distinguish "does not exist" from "exists ' +
            'but is private". Rate limited on one shared bucket, not per API key or IP.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The public uptime for this project.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projectId: { type: 'string', format: 'uuid' },
                      generatedAt: { type: 'string', format: 'date-time' },
                      applications: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
            '404': errorResponse,
            '429': errorResponse,
          },
        },
      },
    },
  };
}
