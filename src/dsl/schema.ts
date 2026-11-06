/**
 * JSON Schema (draft-07 compatible) for assay.checks/v1.
 * Usable as a structured-output schema for the compiler (milestone 2).
 */

const textMatch = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['equals'],
      properties: { equals: { type: 'string' }, ignoreCase: { type: 'boolean' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['contains'],
      properties: { contains: { type: 'string', minLength: 1 }, ignoreCase: { type: 'boolean' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['regex'],
      properties: { regex: { type: 'string', minLength: 1 }, flags: { type: 'string', pattern: '^[imsu]*$' } },
    },
  ],
};

const numberCompare = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    eq: { type: 'number' },
    gt: { type: 'number' },
    gte: { type: 'number' },
    lt: { type: 'number' },
    lte: { type: 'number' },
  },
};

const money = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'currency'],
  properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } },
};

/** A date-time literal must name its offset, so it denotes one instant. */
const instant = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$';

const bound = {
  oneOf: [
    { type: 'number' },
    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    { type: 'string', pattern: instant },
    { $ref: '#/definitions/money' },
  ],
};

const simpleNormalizers = [
  'trim',
  'collapseWhitespace',
  'lowercase',
  'uppercase',
  'nfkc',
  'stripDiacritics',
  'json',
  'boolean',
];

/** Upper bounds of a `sameAs` tolerance: relative (numbers, money), minutes (date-times), days (dates). */
export const MAX_TOLERANCE = { rel: 0.05, minutes: 60, days: 7 } as const;

export const checkSetSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://assay.dev/schema/checks/v1.json',
  title: 'Assay check set (assay.checks/v1)',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'id', 'version', 'task', 'requirements', 'checks'],
  properties: {
    schema: { const: 'assay.checks/v1' },
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    task: {
      type: 'object',
      additionalProperties: false,
      required: ['instruction'],
      properties: { instruction: { type: 'string', minLength: 1 }, outcomes: { type: 'string' } },
    },
    requirements: { type: 'array', minItems: 1, items: { $ref: '#/definitions/requirement' } },
    checks: { type: 'array', items: { $ref: '#/definitions/check' } },
    compiled: {
      type: 'object',
      additionalProperties: false,
      required: ['compiler', 'model', 'modelsUsed', 'at'],
      properties: {
        compiler: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        modelsUsed: { type: 'array', items: { type: 'string', minLength: 1 } },
        at: { type: 'string', minLength: 1 },
        discovery: { enum: ['mined', 'mined+model'] },
      },
    },
    locked: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'at', 'digest'],
      properties: {
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
        digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        note: { type: 'string' },
        content: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        items: { type: 'object', additionalProperties: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
        stress: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        supersedes: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        signature: {
          type: 'object',
          additionalProperties: false,
          required: ['alg', 'keyId', 'value'],
          properties: {
            alg: { const: 'ed25519' },
            keyId: { type: 'string', minLength: 1 },
            value: { type: 'string', pattern: '^[A-Za-z0-9+/]+={0,2}$' },
          },
        },
      },
    },
    rejected: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'at', 'note', 'content'],
      properties: {
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
        note: { type: 'string', minLength: 1 },
        content: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      },
    },
  },
  definitions: {
    textMatch,
    numberCompare,
    money,
    requirement: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'text', 'source'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
        kind: { enum: ['hard', 'soft'] },
        text: { type: 'string', minLength: 1 },
        source: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'quote'],
          properties: { field: { enum: ['instruction', 'outcomes'] }, quote: { type: 'string', minLength: 1 } },
        },
      },
    },
    check: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'requirement', 'description', 'assert'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
        requirement: { type: 'string' },
        description: { type: 'string', minLength: 1 },
        assert: { $ref: '#/definitions/assertion' },
        onFail: { enum: ['escalate', 'keep'] },
        onMissing: { enum: ['fail', 'abstain'] },
      },
    },
    locator: {
      type: 'object',
      additionalProperties: false,
      required: ['role'],
      properties: {
        role: { type: 'string', pattern: '^[a-z]+$' },
        name: { $ref: '#/definitions/textMatch' },
        text: { $ref: '#/definitions/textMatch' },
        level: { type: 'integer', minimum: 1, maximum: 6 },
        landmark: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: {
            role: {
              enum: ['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search'],
            },
            name: { $ref: '#/definitions/textMatch' },
          },
        },
        within: { $ref: '#/definitions/locator' },
        column: { $ref: '#/definitions/textMatch' },
      },
    },
    target: {
      oneOf: [
        { $ref: '#/definitions/locator' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['anchors'],
          properties: { anchors: { type: 'array', minItems: 1, items: { $ref: '#/definitions/locator' } } },
        },
      ],
    },
    urlMatch: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        path: { type: 'string', pattern: '^/' },
        regex: { type: 'string' },
        origin: { type: 'string', pattern: '^https?://' },
        query: {
          type: 'object',
          additionalProperties: { oneOf: [{ type: 'null' }, { $ref: '#/definitions/textMatch' }] },
        },
      },
    },
    pageMatch: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        url: { $ref: '#/definitions/urlMatch' },
        title: { $ref: '#/definitions/textMatch' },
      },
    },
    jsonSchema: { type: ['object', 'boolean'] },
    requestMatch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: { oneOf: [{ type: 'string' }, { type: 'array', minItems: 1, items: { type: 'string' } }] },
        url: { $ref: '#/definitions/urlMatch' },
        status: { oneOf: [{ type: 'integer' }, { $ref: '#/definitions/numberCompare' }] },
        requestBody: { $ref: '#/definitions/jsonSchema' },
        responseBody: { $ref: '#/definitions/jsonSchema' },
      },
    },
    valueSource: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'target', 'field'],
          properties: {
            from: { const: 'node' },
            target: { $ref: '#/definitions/target' },
            field: { enum: ['name', 'value', 'text', 'url'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'pattern'],
          properties: {
            from: { const: 'text' },
            scope: { $ref: '#/definitions/target' },
            pattern: { type: 'string', minLength: 1 },
            flags: { type: 'string', pattern: '^[imsu]*$' },
            group: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'part'],
          properties: {
            from: { const: 'url' },
            part: {
              oneOf: [
                { enum: ['href', 'origin', 'pathname', 'search', 'hash'] },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['param'],
                  properties: { param: { type: 'string' } },
                },
              ],
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'match'],
          properties: {
            from: { enum: ['request', 'response'] },
            match: { $ref: '#/definitions/requestMatch' },
            pointer: { type: 'string', pattern: '^(/.*)?$' },
            pick: { enum: ['only', 'first', 'last'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'area', 'key'],
          properties: {
            from: { const: 'storage' },
            area: { enum: ['cookie', 'local', 'session'] },
            key: { type: 'string' },
            origin: { type: 'string', pattern: '^https?://' },
            at: { enum: ['after', 'before'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'probe'],
          properties: {
            from: { const: 'probe' },
            probe: { type: 'string', minLength: 1 },
            pointer: { type: 'string', pattern: '^(/.*)?$' },
            at: { enum: ['after', 'before'] },
          },
        },
      ],
    },
    normalizer: {
      oneOf: [
        { enum: simpleNormalizers },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: { op: { enum: simpleNormalizers } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'regex'],
          properties: {
            op: { const: 'extract' },
            regex: { type: 'string', minLength: 1 },
            flags: { type: 'string', pattern: '^[imsu]*$' },
            group: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'regex', 'with'],
          properties: {
            op: { const: 'replace' },
            regex: { type: 'string', minLength: 1 },
            flags: { type: 'string', pattern: '^[gimsu]*$' },
            with: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'locale'],
          properties: { op: { const: 'number' }, locale: { type: 'string', minLength: 2 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'locale'],
          properties: {
            op: { const: 'currency' },
            locale: { type: 'string', minLength: 2 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'locale'],
          properties: { op: { const: 'date' }, locale: { type: 'string', minLength: 2 }, timezone: { type: 'string' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'locale'],
          properties: {
            op: { const: 'datetime' },
            locale: { type: 'string', minLength: 2 },
            timezone: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: {
            op: { const: 'items' },
            where: { $ref: '#/definitions/jsonSchema' },
            pointer: { type: 'string', pattern: '^(/.*)?$' },
            pick: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', pattern: '^/' },
            },
            flatten: { type: 'boolean' },
          },
        },
      ],
    },
    tolerance: {
      type: 'object',
      additionalProperties: false,
      required: ['because'],
      anyOf: [{ required: ['abs'] }, { required: ['rel'] }],
      properties: {
        abs: { type: 'number', exclusiveMinimum: 0 },
        rel: { type: 'number', exclusiveMinimum: 0, maximum: MAX_TOLERANCE.rel },
        because: { type: 'string', minLength: 1 },
      },
    },
    comparison: {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['equals'], properties: { equals: {} } },
        {
          type: 'object',
          additionalProperties: false,
          required: ['sameAs'],
          properties: {
            sameAs: {
              type: 'object',
              additionalProperties: false,
              required: ['source'],
              properties: {
                source: { $ref: '#/definitions/valueSource' },
                normalize: { type: 'array', items: { $ref: '#/definitions/normalizer' } },
                tolerance: { $ref: '#/definitions/tolerance' },
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['oneOf'],
          properties: { oneOf: { type: 'array', minItems: 1 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['contains'],
          properties: { contains: { type: 'string', minLength: 1 }, ignoreCase: { type: 'boolean' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['regex'],
          properties: { regex: { type: 'string', minLength: 1 }, flags: { type: 'string', pattern: '^[imsu]*$' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['approx'],
          properties: {
            approx: {
              type: 'object',
              additionalProperties: false,
              required: ['value'],
              anyOf: [{ required: ['abs'] }, { required: ['rel'] }],
              properties: { value: bound, abs: { type: 'number', minimum: 0 }, rel: { type: 'number', minimum: 0 } },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { gt: bound, gte: bound, lt: bound, lte: bound },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['schema'],
          properties: { schema: { $ref: '#/definitions/jsonSchema' } },
        },
        { type: 'object', additionalProperties: false, required: ['exists'], properties: { exists: { const: true } } },
      ],
    },
    assertion: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'target', 'expect'],
          properties: {
            kind: { const: 'state' },
            target: { $ref: '#/definitions/target' },
            expect: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: {
                checked: { enum: [true, false, 'mixed'] },
                pressed: { enum: [true, false, 'mixed'] },
                selected: { type: 'boolean' },
                expanded: { type: 'boolean' },
                disabled: { type: 'boolean' },
                level: { type: 'integer', minimum: 1, maximum: 6 },
                name: { $ref: '#/definitions/textMatch' },
                value: { $ref: '#/definitions/textMatch' },
                text: { $ref: '#/definitions/textMatch' },
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'match'],
          properties: {
            kind: { const: 'contains' },
            scope: { $ref: '#/definitions/target' },
            witness: { $ref: '#/definitions/locator' },
            match: { $ref: '#/definitions/locator' },
            count: { $ref: '#/definitions/numberCompare' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'source', 'expect'],
          properties: {
            kind: { const: 'value' },
            source: { $ref: '#/definitions/valueSource' },
            normalize: { type: 'array', items: { $ref: '#/definitions/normalizer' } },
            expect: { $ref: '#/definitions/comparison' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'match'],
          properties: { kind: { const: 'url' }, match: { $ref: '#/definitions/urlMatch' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'match'],
          properties: {
            kind: { const: 'request' },
            match: { $ref: '#/definitions/requestMatch' },
            count: { $ref: '#/definitions/numberCompare' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'match', 'assert'],
          properties: {
            kind: { const: 'each' },
            scope: { $ref: '#/definitions/target' },
            witness: { $ref: '#/definitions/locator' },
            match: { $ref: '#/definitions/locator' },
            count: { $ref: '#/definitions/numberCompare' },
            assert: { $ref: '#/definitions/assertion' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'match', 'assert'],
          properties: {
            kind: { const: 'page' },
            match: { $ref: '#/definitions/pageMatch' },
            assert: { $ref: '#/definitions/assertion' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'of'],
          properties: {
            kind: { enum: ['allOf', 'anyOf'] },
            of: { type: 'array', minItems: 1, items: { $ref: '#/definitions/assertion' } },
          },
        },
      ],
    },
  },
} as const;
