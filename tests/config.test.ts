import { describe, it, expect } from 'vitest';
import { loadConfig, type EndpointConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('expands NIM_API_KEYS into multiple endpoints', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1,k2', AGNES_COM_API_KEY: 'a', AGNES_CN_API_KEY: 'b' });
    expect(cfg.endpoints.map((e: { name: string }) => e.name)).toEqual(['nim-1', 'nim-2', 'agnes_com', 'agnes_cn']);
  });
  it('applies defaults for tick and timeout', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1' });
    expect(cfg.tickFastMs).toBe(300000);
    expect(cfg.httpTimeoutMs).toBe(120000);
  });
  it('throws on missing all keys', () => {
    expect(() => loadConfig({})).toThrow(/at least one endpoint/i);
  });
  it('uses the pinned base urls for all endpoint families', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1', AGNES_COM_API_KEY: 'a', AGNES_CN_API_KEY: 'b' });
    const byName = Object.fromEntries(cfg.endpoints.map((e: EndpointConfig) => [e.name, e] as const));
    expect(byName['nim-1']?.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(byName['agnes_com']?.baseUrl).toBe('https://apihub.agnes-ai.com/v1');
    expect(byName['agnes_cn']?.baseUrl).toBe('https://api.agnes-ai.cn/v1');
  });
  it('tags env-derived endpoints with the both tier', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1,k2', AGNES_COM_API_KEY: 'a', AGNES_CN_API_KEY: 'b' });
    expect(cfg.endpoints.map((e: EndpointConfig) => e.tier)).toEqual([
      'both',
      'both',
      'both',
      'both',
    ]);
  });
  it('tags env-derived endpoints with their provider family', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1', AGNES_COM_API_KEY: 'a', AGNES_CN_API_KEY: 'b' });
    const byName = Object.fromEntries(cfg.endpoints.map((e: EndpointConfig) => [e.name, e] as const));
    expect(byName['nim-1']?.provider).toBe('nvidia_nim');
    expect(byName['agnes_com']?.provider).toBe('agnes');
    expect(byName['agnes_cn']?.provider).toBe('agnes');
  });
  it('rejects non-integer timing values', () => {
    expect(() => loadConfig({ NIM_API_KEYS: 'k1', TICK_FAST_MS: '1.5' })).toThrow(/TICK_FAST_MS/i);
  });
  it('defaults the conversation and queue limits', () => {
    const cfg = loadConfig({ NIM_API_KEYS: 'k1' });
    expect(cfg.maxConversationsPerTick).toBe(3);
    expect(cfg.maxEventsPerConversation).toBe(20);
    expect(cfg.maxQueueSize).toBe(500);
  });
  it('reads the conversation and queue limits from the environment', () => {
    const cfg = loadConfig({
      NIM_API_KEYS: 'k1',
      MAX_CONVERSATIONS_PER_TICK: '5',
      MAX_EVENTS_PER_CONVERSATION: '7',
      MAX_QUEUE_SIZE: '42',
    });
    expect(cfg.maxConversationsPerTick).toBe(5);
    expect(cfg.maxEventsPerConversation).toBe(7);
    expect(cfg.maxQueueSize).toBe(42);
  });
  it.each(['0', '-1', '1.5', 'lots'])('rejects %s as a conversation limit', (value) => {
    expect(() =>
      loadConfig({ NIM_API_KEYS: 'k1', MAX_CONVERSATIONS_PER_TICK: value }),
    ).toThrow(/MAX_CONVERSATIONS_PER_TICK/i);
    expect(() =>
      loadConfig({ NIM_API_KEYS: 'k1', MAX_EVENTS_PER_CONVERSATION: value }),
    ).toThrow(/MAX_EVENTS_PER_CONVERSATION/i);
    expect(() => loadConfig({ NIM_API_KEYS: 'k1', MAX_QUEUE_SIZE: value })).toThrow(
      /MAX_QUEUE_SIZE/i,
    );
  });
});

describe('loadConfig without env endpoints', () => {
  it('returns non-endpoint settings when endpoints come from models.json', () => {
    const cfg = loadConfig({ TICK_FAST_MS: '1000' }, { requireEndpoints: false });
    expect(cfg.endpoints).toEqual([]);
    expect(cfg.tickFastMs).toBe(1000);
  });
});

describe('REDLINE_FALLBACK_TEXT', () => {
  it('uses the built-in default when the env is missing or blank', () => {
    expect(loadConfig({ NIM_API_KEYS: 'k1' }).redlineFallbackText).toBe(
      '这个我不聊。',
    );
    expect(
      loadConfig({ NIM_API_KEYS: 'k1', REDLINE_FALLBACK_TEXT: '   ' }).redlineFallbackText,
    ).toBe('这个我不聊。');
  });

  it('reads a trimmed override', () => {
    expect(
      loadConfig({ NIM_API_KEYS: 'k1', REDLINE_FALLBACK_TEXT: ' 换个话题。 ' })
        .redlineFallbackText,
    ).toBe('换个话题。');
  });
});
