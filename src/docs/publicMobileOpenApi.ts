import type { OpenAPIV3 } from 'openapi-types';

/** OpenAPI 3 spec for the public mobile Authenticate APIs (plain REST, no JWT). */
export const publicMobileOpenApi: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Hudoori Public Mobile APIs',
    description:
      'Unauthenticated REST endpoints for mobile app version publishing. Responses match the legacy Authenticate mobile-update contract.',
    version: '1.0.0',
  },
  servers: [
    { url: '/', description: 'Current host' },
  ],
  paths: {
    '/api/Authenticate/GetAllMobileVersions': {
      get: {
        tags: ['Mobile Versions'],
        summary: 'GetAllMobileVersions',
        description: 'Returns all mobile version rows.',
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/MobileVersion' },
                },
                example: [
                  { id: 1, isPublish: 'false', version: '1.69' },
                  { id: 2, isPublish: 'true', version: '1.65' },
                ],
              },
            },
          },
        },
      },
    },
    '/api/Authenticate/AddMobileUpdate': {
      post: {
        tags: ['Mobile Versions'],
        summary: 'AddMobileUpdate',
        description: 'Creates a mobile version row. Omit `id` (or send 0) to auto-increment.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MobileVersionCreate' },
              example: { id: 0, isPublish: 'false', version: '2.0.10' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MobileVersion' },
              },
            },
          },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/api/Authenticate/UpdateMobileUpdate/{id}': {
      put: {
        tags: ['Mobile Versions'],
        summary: 'UpdateMobileUpdate',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer', format: 'int32' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MobileVersionUpdate' },
              example: { version: '2.0.11', isPublish: 'true' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MobileVersion' },
              },
            },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Not found' },
        },
      },
    },
  },
  components: {
    schemas: {
      MobileVersion: {
        type: 'object',
        required: ['id', 'isPublish', 'version'],
        properties: {
          id: { type: 'integer', format: 'int32' },
          isPublish: {
            type: 'string',
            description: 'String flag: "true" or "false"',
            example: 'true',
          },
          version: { type: 'string', example: '2.0.9' },
        },
      },
      MobileVersionCreate: {
        type: 'object',
        required: ['version'],
        properties: {
          id: {
            type: 'integer',
            format: 'int32',
            description: 'Optional. Use 0 or omit for auto-increment.',
          },
          isPublish: { type: 'string', example: 'false' },
          version: { type: 'string' },
        },
      },
      MobileVersionUpdate: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          isPublish: { type: 'string' },
        },
      },
    },
  },
};
