/**
 * Node tags (plan 018): an operator labels the node in `node.tags`. A bad tag
 * stops the config loading rather than being silently dropped, and the parser
 * that reads tags from strangers never throws and never passes junk through.
 */
import { describe, expect, test } from 'bun:test';
import { withDefaults } from '../src/environment/defaults';
import { validateEnvironment } from '../src/environment/validate';
import { MAX_TAGS, parseTags } from '../src/utils/nodeInfo';
import { LOG_LEVEL_NAMES, LogLevel, parseLogLevel } from '../src/utils/logger';

const localWith = (tags: unknown) =>
  validateEnvironment(withDefaults({
    local: { enabled: true, privateTopic: 'tags-test/models/1.0.0' },
    node: { tags } as any,
  }));

const tagErrors = (tags: unknown) => localWith(tags).filter((e) => e.includes('node.tags'));

describe('node.tags in the config', () => {
  test('valid tags pass', () => {
    expect(tagErrors(['cuda', 'apple-silicon', 'apple-silicon-m4-pro', 'nvidia-dgx-spark', 'rtx4090'])).toEqual([]);
  });

  test('leaving tags out is fine', () => {
    expect(localWith(undefined).filter((e) => e.includes('node.tags'))).toEqual([]);
  });

  test.each([
    ['uppercase', ['CUDA']],
    ['a space', ['apple silicon']],
    ['a leading hyphen', ['-cuda']],
    ['too long', ['a'.repeat(49)]],
    ['a non-string', [42]],
    ['a duplicate', ['cuda', 'cuda']],
    ['too many', Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)],
    ['not a list', 'cuda'],
  ])('%s is a validation error', (_label, tags) => {
    expect(tagErrors(tags).length).toBe(1);
  });

  test('the error names the bad tag', () => {
    expect(tagErrors(['cuda', 'Apple'])[0]).toContain('"Apple"');
  });
});

describe('parseTags (peer-supplied tags)', () => {
  test('returns a clean copy of a valid list', () => {
    const input = ['cuda', 'nvidia-dgx-spark'];
    const out = parseTags(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test('never throws, and rejects anything that is not a valid list', () => {
    const junk: unknown[] = [
      undefined, null, 0, 'cuda', {}, { length: 1, 0: 'cuda' }, [null], [['cuda']], ['__proto__'],
      ['CUDA'], ['ok', 'ok'], Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`), [{ toString: () => 'cuda' }],
    ];
    for (const value of junk) {
      expect(() => parseTags(value)).not.toThrow();
      expect(parseTags(value)).toBeUndefined();
    }
  });

  test('an empty list is valid', () => {
    expect(parseTags([])).toEqual([]);
  });
});

// Plan 020 lives here with the other `node.*` settings.
describe('node.logLevel', () => {
  const levelErrors = (logLevel: unknown) =>
    validateEnvironment(withDefaults({
      local: { enabled: true, privateTopic: 'tags-test/models/1.0.0' },
      node: { logLevel } as any,
    })).filter((e) => e.includes('node.logLevel'));

  test('the four level names pass, and a typo is named', () => {
    for (const level of LOG_LEVEL_NAMES) expect(levelErrors(level)).toEqual([]);
    expect(levelErrors('verbose')).toEqual(['`node.logLevel` must be one of debug, info, warn, error (got "verbose").']);
    expect(levelErrors(1)).toHaveLength(1);
  });

  test('parseLogLevel is case-insensitive and rejects anything else', () => {
    expect(parseLogLevel('DEBUG')).toBe(LogLevel.DEBUG);
    expect(parseLogLevel(' warn ')).toBe(LogLevel.WARN);
    expect(parseLogLevel('error')).toBe(LogLevel.ERROR);
    expect(parseLogLevel('silent')).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});
