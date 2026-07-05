import test from 'node:test';
import assert from 'node:assert/strict';

import { validateParsedTools, validateValueAgainstSchema } from '../../src/core/tool-validation.js';

const tool = {
  type: 'function',
  function: {
    name: 'Read',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 2, maxLength: 20, pattern: '^/' },
        mode: { enum: ['fast', 'full'] },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
};

test('validateValueAgainstSchema detects required and type failures', () => {
  const errors = validateValueAgainstSchema({ count: 'x' }, tool.function.parameters, 'Read');
  assert.ok(errors.some(e => e.includes("missing required property 'file_path'")));
  assert.ok(errors.some(e => e.includes("Read.count: expected type 'integer'")));

  const inherited = Object.create({ file_path: '/inherited' });
  assert.ok(validateValueAgainstSchema(inherited, tool.function.parameters, 'Read').some(e => e.includes("missing required property 'file_path'")));
});

test('validateValueAgainstSchema detects enum pattern length and additional properties', () => {
  const errors = validateValueAgainstSchema({ file_path: 'x', mode: 'slow', extra: true }, tool.function.parameters, 'Read');
  assert.ok(errors.some(e => e.includes('minLength=2')));
  assert.ok(errors.some(e => e.includes('pattern')));
  assert.ok(errors.some(e => e.includes('expected one of')));
  assert.ok(errors.some(e => e.includes("unexpected property 'extra'")));
});

test('validateValueAgainstSchema validates boolean schemas and numeric and array constraints', () => {
  assert.deepEqual(validateValueAgainstSchema('anything', true, 'v'), []);
  assert.ok(validateValueAgainstSchema('anything', false, 'v')[0].includes('not allowed'));
  assert.ok(validateValueAgainstSchema({ forbidden: 'x' }, { type: 'object', properties: { forbidden: false } }, 'obj')[0].includes('not allowed'));
  assert.ok(validateValueAgainstSchema(['x'], { type: 'array', items: false }, 'items')[0].includes('not allowed'));
  assert.ok(validateValueAgainstSchema(0, { type: 'integer', minimum: 1 }, 'count')[0].includes('minimum=1'));
  assert.ok(validateValueAgainstSchema(3, { type: 'integer', maximum: 2 }, 'count')[0].includes('maximum=2'));
  assert.ok(validateValueAgainstSchema(1, { type: 'number', exclusiveMinimum: 1 }, 'count')[0].includes('exclusiveMinimum=1'));
  assert.ok(validateValueAgainstSchema(2, { type: 'number', exclusiveMaximum: 2 }, 'count')[0].includes('exclusiveMaximum=2'));
  assert.ok(validateValueAgainstSchema([], { type: 'array', minItems: 1 }, 'items')[0].includes('minItems=1'));
  assert.ok(validateValueAgainstSchema([1, 2, 3], { type: 'array', maxItems: 2 }, 'items')[0].includes('maxItems=2'));
});

test('validateValueAgainstSchema validates array items', () => {
  const errors = validateValueAgainstSchema({ file_path: '/ok', tags: ['a', 1] }, tool.function.parameters, 'Read');
  assert.ok(errors.some(e => e.includes("Read.tags[1]: expected type 'string'")));
});

test('validateValueAgainstSchema supports const anyOf oneOf allOf', () => {
  assert.deepEqual(validateValueAgainstSchema('x', { const: 'x' }, 'v'), []);
  assert.deepEqual(validateValueAgainstSchema(-0, { const: 0 }, 'v'), []);
  assert.deepEqual(validateValueAgainstSchema(-0, { enum: [0] }, 'v'), []);
  assert.ok(validateValueAgainstSchema('y', { const: 'x' }, 'v')[0].includes('expected const'));

  assert.deepEqual(validateValueAgainstSchema(1, { anyOf: [{ type: 'string' }, { type: 'integer' }] }, 'v'), []);
  assert.ok(validateValueAgainstSchema(true, { anyOf: [{ type: 'string' }, { type: 'integer' }] }, 'v')[0].includes('anyOf'));

  assert.deepEqual(validateValueAgainstSchema(1, { oneOf: [{ type: 'integer' }, { type: 'string' }] }, 'v'), []);
  assert.ok(validateValueAgainstSchema(1, { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 'v')[0].includes('exactly one'));

  assert.deepEqual(validateValueAgainstSchema({ a: 'x' }, { allOf: [{ type: 'object' }, { properties: { a: { type: 'string' } }, required: ['a'] }] }, 'v'), []);
});

test('validateParsedTools validates tool names tool_choice and schema', () => {
  assert.equal(validateParsedTools([{ name: 'Read', args: { file_path: '/tmp' } }], [tool], 'auto'), null);
  assert.equal(validateParsedTools([{ name: 'Read', args_json: { file_path: '/tmp' } }], [tool], 'auto'), null);
  assert.match(validateParsedTools([{ name: 'Never', args: {} }], [{ type: 'function', function: { name: 'Never', parameters: false } }], 'auto'), /not allowed/);
  assert.match(validateParsedTools([{ name: 'Write', args: {} }], [tool], 'auto'), /unknown tool/);
  assert.match(validateParsedTools([{ name: 'Read', args: [] }], [tool], 'auto'), /arguments must be a JSON object/);
  assert.match(validateParsedTools([{ name: 'Read', args: { file_path: '/tmp' } }], [tool], { type: 'function', function: { name: 'Write' } }), /tool_choice/);
  assert.match(validateParsedTools([{ name: 'Read', args: { file_path: 'x' } }], [tool], 'auto'), /schema validation failed/);
});
