/**
 * `list-models-response`s are a stranger's bytes (review H2): they are kept only
 * for a request this node has open, once per peer, and bounded in size.
 */
import { describe, expect, test } from 'bun:test';
import {
  ModelListCollector,
  MAX_MODELS_PER_RESPONSE,
  MAX_RESPONDERS,
  MAX_MODEL_ID_LENGTH,
} from '../src/messaging/modelListCollector';

describe('ModelListCollector', () => {
  test('an unsolicited response is dropped and starts nothing', () => {
    const c = new ModelListCollector();
    expect(c.add('nobody-asked', 'peer-a', [{ id: 'm' }])).toBe(false);
    expect(c.close('nobody-asked')).toEqual([]);
  });

  test('a response for an open request is kept and de-duplicated by model id', () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    expect(c.add('r', 'a', [{ id: 'x' }, { id: 'y' }])).toBe(true);
    expect(c.add('r', 'b', [{ id: 'y' }, { id: 'z' }])).toBe(true);
    expect(c.close('r').map((m) => m.id).sort()).toEqual(['x', 'y', 'z']);
  });

  test('only the first response from each peer counts', () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    expect(c.add('r', 'a', [{ id: 'first' }])).toBe(true);
    expect(c.add('r', 'a', [{ id: 'second' }])).toBe(false);
    expect(c.close('r').map((m) => m.id)).toEqual(['first']);
  });

  test('entries that are not models are filtered out, a non-list is refused', () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    expect(c.add('r', 'a', 'garbage')).toBe(false);
    expect(c.add('r', 'b', [{ id: 'ok' }, null, 5, 'x', { notId: 1 }, { id: 7 }, { id: '' }])).toBe(true);
    expect(c.close('r').map((m) => m.id)).toEqual(['ok']);
  });

  test('one response is capped in count and ids in length', () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    const many = Array.from({ length: MAX_MODELS_PER_RESPONSE + 50 }, (_, i) => ({ id: `m${i}` }));
    c.add('r', 'a', [{ id: 'x'.repeat(MAX_MODEL_ID_LENGTH + 1) }, ...many]);
    expect(c.close('r')).toHaveLength(MAX_MODELS_PER_RESPONSE);
  });

  test('the number of responders is capped', () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    for (let i = 0; i < MAX_RESPONDERS; i++) expect(c.add('r', `p${i}`, [{ id: 'm' }])).toBe(true);
    expect(c.add('r', 'one-more', [{ id: 'm' }])).toBe(false);
  });

  test('a closed or expired collection takes nothing more', async () => {
    const c = new ModelListCollector();
    c.open('r', 60_000);
    c.close('r');
    expect(c.add('r', 'a', [{ id: 'm' }])).toBe(false);
    c.open('short', 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(c.add('short', 'a', [{ id: 'm' }])).toBe(false);
    expect(c.isOpen('short')).toBe(false);
  });
});
