import { describe, it, expect } from 'vitest';
import { sanitizeForTty, stripUnsafeControls } from '../src/util/tty.js';
import { checkAction } from '../src/persona/redlines.js';

describe('stripUnsafeControls', () => {
  it('strips OSC sequences terminated by BEL', () => {
    expect(stripUnsafeControls('a\u001b]0;title\u0007b')).toBe('ab');
  });

  it('strips OSC sequences terminated by ST', () => {
    expect(stripUnsafeControls('a\u001b]0;title\u001b\\b')).toBe('ab');
  });

  it('strips CSI sequences, including private parameter bytes', () => {
    expect(stripUnsafeControls('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripUnsafeControls('a\u001b[>0cb')).toBe('ab');
  });

  it('strips other two-character escapes', () => {
    expect(stripUnsafeControls('a\u001bMb')).toBe('ab');
  });

  it('strips C0 controls but keeps newline and tab', () => {
    expect(stripUnsafeControls('a\u0000b\u0007c\r\nd\te')).toBe('abc\nd\te');
  });

  it('strips DEL', () => {
    expect(stripUnsafeControls('a\u007fb')).toBe('ab');
  });

  it('strips C1 controls (8-bit CSI and NEL)', () => {
    expect(stripUnsafeControls('a\u009bb')).toBe('ab');
    expect(stripUnsafeControls('a\u0085b')).toBe('ab');
  });

  it('strips line and paragraph separators', () => {
    expect(stripUnsafeControls('a\u2028b\u2029c')).toBe('abc');
  });

  it('strips zero-width and bidi format characters', () => {
    expect(stripUnsafeControls('ri\u200bcin')).toBe('ricin');
    expect(stripUnsafeControls('\u202eabc\u202c')).toBe('abc');
    expect(stripUnsafeControls('\u2066a\u2069')).toBe('a');
    expect(stripUnsafeControls('a\u200fb')).toBe('ab');
  });

  it('strips zero-width, BOM and word-joiner characters inside keywords', () => {
    expect(stripUnsafeControls('b\u200bomb')).toBe('bomb');
    expect(stripUnsafeControls('\ufeffbo\u2060mb')).toBe('bomb');
  });

  it('strips soft hyphen, Mongolian vowel separator, variation selectors and tag characters', () => {
    expect(stripUnsafeControls('a\u00adb')).toBe('ab');
    expect(stripUnsafeControls('a\u180eb')).toBe('ab');
    expect(stripUnsafeControls('a\ufe0fb')).toBe('ab');
    expect(stripUnsafeControls('a\u{E0041}b')).toBe('ab');
  });

  it('canonicalizes fullwidth compatibility characters with NFKC', () => {
    expect(stripUnsafeControls('\uff42\uff4f\uff4d\uff42')).toBe('bomb');
  });

  it('canonicalizes fullwidth text so the redline gate sees ASCII', () => {
    const text = stripUnsafeControls('\uff4d\uff41\uff4b\uff45 \uff41 \uff42\uff4f\uff4d\uff42');
    expect(text).toBe('make a bomb');
    expect(checkAction({ kind: 'message_send', detail: text }).allowed).toBe(false);
  });

  it('handles empty input', () => {
    expect(stripUnsafeControls('')).toBe('');
  });
});

describe('sanitizeForTty', () => {
  it('prefixes every physical line with the default marker', () => {
    expect(sanitizeForTty('a\nb')).toBe('| a\n| b');
  });

  it('accepts a distinct prefix for untrusted model output', () => {
    expect(sanitizeForTty('a\nb', '|> ')).toBe('|> a\n|> b');
  });

  it('sanitizes before prefixing', () => {
    expect(sanitizeForTty('x\u001b[31my\u001b[0m', '|> ')).toBe('|> xy');
  });

  it('returns just the marker for empty input', () => {
    expect(sanitizeForTty('')).toBe('| ');
  });
});
