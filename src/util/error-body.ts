/**
 * Bounded reader for upstream error bodies.
 *
 * Shared by the brain (failover classification) and the models API (probe
 * classification). The text is only ever used for classification: callers must
 * never echo it into a response or a log line.
 */

/** Upper bound on how much of an error body is read. */
export const MAX_ERROR_BODY_CHARS = 4_096;

/**
 * Reads at most `maxChars` characters of a response body. Streams the response
 * instead of buffering it so a huge error page cannot exhaust memory; cancels
 * the reader once the quota is collected.
 */
export async function readBoundedErrorBody(
  response: Response,
  maxChars: number = MAX_ERROR_BODY_CHARS,
): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return '';
  }

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // Keep whatever prefix was read; classification only needs the leading bytes.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
  }
  return text.slice(0, maxChars);
}
