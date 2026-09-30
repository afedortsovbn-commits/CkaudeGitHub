import { describe, expect, it } from 'vitest';
import { parseTurnUrls } from './release';

describe('parseTurnUrls', () => {
  it('имена по порядку или явные', () => {
    expect(parseTurnUrls('turn:a:3478, turn:a:3479')).toEqual([
      { name: 'coturn-1', url: 'turn:a:3478' },
      { name: 'coturn-2', url: 'turn:a:3479' },
    ]);
    expect(parseTurnUrls('edge=turn:b:3478?transport=tcp')).toEqual([
      { name: 'edge', url: 'turn:b:3478?transport=tcp' },
    ]);
    expect(parseTurnUrls('')).toEqual([]);
  });
});
