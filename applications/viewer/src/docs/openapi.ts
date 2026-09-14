/**
 * The OpenAPI 3.0 document served at `/openapi.json` and rendered at `/docs`.
 *
 * Query parameters and response shapes are described here because OpenAPI
 * wants them per-parameter rather than as one object schema. No zod-derived
 * request body schema here any more - `POST /api/v1/ingest` (the one route
 * that had one) moved to `@metrion/ingest`, whose own `docs/openapi.ts` keeps
 * the same "converted from the runtime zod schema" pattern for its body.
 */

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

const applicationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string', example: 'checkout-api' },
    displayName: { type: 'string', nullable: true, example: 'Checkout API' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const thresholdSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    applicationId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description: 'null = every application in the project.',
    },
    subResource: { type: 'string', nullable: true },
    metricName: { type: 'string', example: 'http.5xx.rate' },
    direction: { type: 'string', enum: ['above', 'below'] },
    warningValue: { type: 'number', nullable: true },
    criticalValue: { type: 'number', nullable: true },
    consecutiveBreaches: { type: 'integer', minimum: 1, maximum: 10 },
    windowSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/** Only `ok`/`warning`/`critical` are ever returned - never a colour or hex
 * value, a presentation decision that belongs to the client, not the API. */
const statusEnum = { type: 'string', enum: ['ok', 'warning', 'critical'] };

const applicationStatusSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string' },
    displayName: { type: 'string', nullable: true },
    status: { ...statusEnum, description: "This application's own worst threshold state." },
    effectiveStatus: {
      ...statusEnum,
      description:
        "The worse of `status` and the worst status among this application's transitive dependencies.",
    },
    causedBy: {
      type: 'object',
      nullable: true,
      description:
        'Set only when `effectiveStatus` came from a dependency, not from this application itself.',
      properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' } },
    },
    thresholds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          metricName: { type: 'string' },
          state: statusEnum,
          reason: { type: 'string', enum: ['threshold', 'no_data'] },
          value: { type: 'number', nullable: true },
          since: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

const projectIdPathParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const applicationIdPathParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const rangeParameters = [
  {
    name: 'from',
    in: 'query',
    required: true,
    description:
      'Start of the range, ISO-8601. Required: a caller who forgets it gets a 400 naming the field, not a silent all-time query.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to',
    in: 'query',
    required: true,
    description:
      'End of the range, ISO-8601. Must not be earlier than `from`. Ranges over 7 days are answered from the `metrics_hourly` rollup rather than the raw table - see the `source` field on `GET /api/v1/metrics`.',
    schema: { type: 'string', format: 'date-time' },
  },
];

export function buildOpenApiDocument(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'metrion viewer API',
      version: '0.1.0',
      description:
        'Reads the minute-by-minute metrics the metrion agent sends, stored in Postgres/TimescaleDB.\n\n' +
        "Every response is scoped to the caller's own projects - see " +
        'docs/adr/0004-postgres-timescaledb-over-append-blob.md. No client IP, user agent, request ' +
        'path or query string exists anywhere in this pipeline - request metrics are aggregated per ' +
        'hostname only.\n\n' +
        'Writing metrics is done through the separate `@metrion/ingest` service, not this app - ' +
        'see its own `/openapi.json`.\n\n' +
        // Swagger UI renders `info.description` as Markdown at the top of the
        // page, so the legal links land on this second public surface without
        // `customCss`, `customJsStr`, or any widening of the deliberately
        // narrow CSP on the /docs route. Austrian ECG applies to this page as
        // much as to the app itself.
        'Legal: [Impressum](/impressum) | [Privacy Policy](/privacy) | ' +
        '[Terms of Use](/terms)',
    },
    tags: [
      { name: 'metrics', description: 'Reading stored metrics.' },
      { name: 'health', description: 'Liveness.' },
      {
        name: 'applications',
        description: 'Naming applications and recording the dependency graph between them.',
      },
      { name: 'thresholds', description: 'Per-metric warning/critical bounds.' },
      {
        name: 'status',
        description:
          'Computed ok/warning/critical status per application. Reads whatever is currently in ' +
          '`threshold_status`/`status_events` - the evaluator that populates those tables on a ' +
          'schedule is a separate, later piece of work, so a project answers "ok" for every ' +
          'application until it ships.',
      },
    ],
    paths: {
      '/api/v1/health/liveness': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe.',
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
      '/api/v1/resources': {
        get: {
          tags: ['metrics'],
          summary: 'Distinct resources, sub-resources and metric names seen in a range.',
          parameters: rangeParameters,
          responses: {
            '200': {
              description: 'What is available to chart.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      resources: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            resource: { type: 'string', example: 'vps-contabo-01' },
                            subResources: {
                              type: 'array',
                              items: { type: 'string', example: 'container:portfolio-caddy-1' },
                            },
                            metricNames: {
                              type: 'array',
                              items: { type: 'string', example: 'cpu.usage' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/v1/metrics': {
        get: {
          tags: ['metrics'],
          summary: 'One downsampled series.',
          parameters: [
            ...rangeParameters,
            {
              name: 'resource',
              in: 'query',
              required: true,
              schema: { type: 'string', example: 'vps-contabo-01' },
            },
            {
              name: 'subResource',
              in: 'query',
              required: false,
              description: 'Omit for the host-level series.',
              schema: { type: 'string', example: 'container:portfolio-caddy-1' },
            },
            {
              name: 'name',
              in: 'query',
              required: true,
              description:
                'Repeatable. Pass it once per metric to get them all from a single query - `name = ANY(...)`, not one round trip per name.',
              explode: true,
              schema: { type: 'array', items: { type: 'string', example: 'cpu.usage' } },
            },
            {
              name: 'stepSeconds',
              in: 'query',
              required: false,
              description: 'Bucket width. Floored at the collector’s own 60s sampling interval.',
              schema: { type: 'integer', minimum: 60, maximum: 86400, default: 60 },
            },
          ],
          responses: {
            '200': {
              description: 'The series, bucketed to `stepSeconds` and averaged within each bucket.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      series: {
                        type: 'array',
                        description: 'One entry per requested `name`, in the order asked for.',
                        items: {
                          type: 'object',
                          properties: {
                            resource: { type: 'string' },
                            subResource: { type: 'string', nullable: true },
                            name: { type: 'string' },
                            unit: { type: 'string', nullable: true },
                            stepSeconds: { type: 'integer' },
                            points: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  timestamp: { type: 'string', format: 'date-time' },
                                  value: { type: 'number' },
                                  count: {
                                    type: 'integer',
                                    description: 'Raw points the bucket average is over.',
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      source: {
                        type: 'string',
                        enum: ['raw', 'hourly'],
                        description:
                          'Which table answered: `raw` for the `metrics` hypertable (ranges up to 7 days), `hourly` for the `metrics_hourly` continuous aggregate (wider ranges).',
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/v1/projects/{id}/applications': {
        get: {
          tags: ['applications'],
          summary: "An project's applications, with each one's current status.",
          parameters: [projectIdPathParameter],
          responses: {
            '200': {
              description: 'The applications.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      applications: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            key: { type: 'string' },
                            displayName: { type: 'string', nullable: true },
                            status: statusEnum,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        post: {
          tags: ['applications'],
          summary: 'Registers a new application.',
          parameters: [projectIdPathParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['key', 'displayName'],
                  properties: {
                    key: {
                      type: 'string',
                      description:
                        'Same `IDENTIFIER` charset the ingest endpoint uses for `resource` - letters, digits, dot, underscore, colon, hyphen.',
                      example: 'checkout-api',
                    },
                    displayName: { type: 'string', example: 'Checkout API' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created.',
              content: { 'application/json': { schema: applicationSchema } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
          },
        },
      },
      '/api/v1/applications/{id}': {
        patch: {
          tags: ['applications'],
          summary: "Renames an application's display name. `key` is immutable.",
          parameters: [applicationIdPathParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['displayName'],
                  properties: { displayName: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated.',
              content: { 'application/json': { schema: applicationSchema } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        delete: {
          tags: ['applications'],
          summary: 'Deletes an application, cascading its dependency edges, thresholds and status.',
          description:
            'Historical `metrics` rows recorded under this application are NOT deleted - the response states this.',
          parameters: [applicationIdPathParameter],
          responses: {
            '200': {
              description: 'Deleted.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      deleted: { type: 'boolean' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/api/v1/applications/{id}/dependencies': {
        get: {
          tags: ['applications'],
          summary: 'What this application depends on, and what depends on it.',
          parameters: [applicationIdPathParameter],
          responses: {
            '200': {
              description: 'The edges.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      dependsOn: { type: 'array', items: { type: 'string', format: 'uuid' } },
                      dependents: { type: 'array', items: { type: 'string', format: 'uuid' } },
                    },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        put: {
          tags: ['applications'],
          summary: 'Replaces the whole `dependsOn` set in one transaction.',
          description:
            'A recursive CTE inside the same transaction rejects a cycle with 409, naming the offending path ' +
            '(`checkout-api -> payments-service -> checkout-api`); the edge set is unchanged after a rejected write.',
          parameters: [applicationIdPathParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['dependsOn'],
                  properties: {
                    dependsOn: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Replaced.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      dependsOn: { type: 'array', items: { type: 'string', format: 'uuid' } },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': {
              description: 'The proposed set creates a dependency cycle.',
              content: {
                'application/json': { schema: errorResponse.content['application/json'].schema },
              },
            },
          },
        },
      },
      '/api/v1/projects/{id}/thresholds': {
        get: {
          tags: ['thresholds'],
          summary: "A project's thresholds.",
          parameters: [projectIdPathParameter],
          responses: {
            '200': {
              description: 'The thresholds.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { thresholds: { type: 'array', items: thresholdSchema } },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        post: {
          tags: ['thresholds'],
          summary: 'Creates a threshold.',
          description:
            'A `direction: "below"` threshold with `warningValue` less strict than `criticalValue` (i.e. ' +
            '`criticalValue > warningValue`) is rejected with 400, and symmetrically for `"above"`.',
          parameters: [projectIdPathParameter],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: thresholdSchema } },
          },
          responses: {
            '201': {
              description: 'Created.',
              content: { 'application/json': { schema: thresholdSchema } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
          },
        },
      },
      '/api/v1/thresholds/{id}': {
        patch: {
          tags: ['thresholds'],
          summary: 'Partially updates a threshold.',
          parameters: [applicationIdPathParameter],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: thresholdSchema } },
          },
          responses: {
            '200': {
              description: 'Updated.',
              content: { 'application/json': { schema: thresholdSchema } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        delete: {
          tags: ['thresholds'],
          summary: 'Deletes a threshold.',
          parameters: [applicationIdPathParameter],
          responses: {
            '204': { description: 'Deleted.' },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/api/v1/projects/{id}/status': {
        get: {
          tags: ['status'],
          summary: 'Per-application ok/warning/critical status, including dependency attribution.',
          description:
            'Never a colour or hex value - green/orange/red is a presentation decision the client makes.',
          parameters: [projectIdPathParameter],
          responses: {
            '200': {
              description: 'The statuses.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      applications: { type: 'array', items: applicationStatusSchema },
                    },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/api/v1/projects/{id}/status/events': {
        get: {
          tags: ['status'],
          summary: 'Recent status transitions, newest first.',
          parameters: [
            projectIdPathParameter,
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'The events.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      events: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            applicationId: { type: 'string', format: 'uuid', nullable: true },
                            thresholdId: { type: 'string', format: 'uuid' },
                            metricName: { type: 'string' },
                            fromState: { type: 'string' },
                            toState: { type: 'string' },
                            value: { type: 'number', nullable: true },
                            at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
    },
  };
}
