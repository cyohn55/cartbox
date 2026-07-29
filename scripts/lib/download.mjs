/**
 * Retrying download for the fetch-* asset scripts.
 *
 * Every game bundle starts as a download from a third-party mirror — archive.org,
 * id's FTP mirror, GitHub releases. Those mirrors return the occasional 5xx or
 * drop a connection, and the deploy workflow builds *every* bundle in sequence,
 * so a single flake anywhere aborts the whole run. That is not hypothetical: run
 * 30427849614 failed on `Download failed: 500 Internal Server Error` fetching
 * wolf3dsw.zip, a URL that served fine minutes later.
 *
 * Retrying a transient failure is safe here precisely because it changes nothing
 * about trust: every caller still verifies the bytes against a pinned sha256.
 * This only decides *how many times to ask*, never *what is acceptable*.
 *
 * `fetchImpl` and `sleep` are injected so the retry policy is testable against
 * real responses without a network or a real delay.
 */

/**
 * Statuses worth asking again about: overload, rate limiting and gateway faults
 * are states of the mirror, not of the request. A 404 or a 403 is an answer —
 * retrying it just turns a clear failure into a slow one.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Upper bound on an honoured Retry-After, so a mirror cannot stall the build. */
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a failed attempt is worth repeating. */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * The server's own requested delay, in milliseconds, or null if it did not ask.
 *
 * Accepts the delay-seconds form (the one mirrors actually send); an HTTP-date
 * is ignored rather than guessed at.
 */
export function retryAfterMs(headers) {
  const header = headers?.get?.("retry-after");
  if (!header) return null;

  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Exponential backoff for attempt n (0-based). */
function backoffMs(attempt, baseDelayMs) {
  return baseDelayMs * 2 ** attempt;
}

/**
 * Downloads a URL, retrying transient failures, and returns the bytes.
 *
 * Throws with the last failure's status once the attempts are spent, so a
 * genuinely dead mirror still fails the build — loudly, and with the reason.
 *
 * @param {string} url
 * @param {{attempts?: number, baseDelayMs?: number, fetchImpl?: typeof fetch,
 *          sleep?: (ms: number) => Promise<void>, onRetry?: (info: object) => void}} [options]
 * @returns {Promise<Buffer>}
 */
export async function downloadBytes(url, options = {}) {
  const {
    attempts = 4,
    baseDelayMs = 1000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    onRetry = ({ attempt, attempts: total, reason, delayMs }) =>
      console.log(`  ${reason}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${total})`),
  } = options;

  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;

    try {
      response = await fetchImpl(url);
    } catch (error) {
      // A refused connection or a reset socket — always worth another ask.
      lastError = new Error(`Download failed: ${error.message}`);

      if (attempt === attempts - 1) break;

      const delayMs = backoffMs(attempt, baseDelayMs);
      onRetry({ attempt, attempts, reason: error.message, delayMs });
      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    const reason = `Download failed: ${response.status} ${response.statusText}`;
    lastError = new Error(reason);

    // A permanent answer: fail now rather than after four identical refusals.
    if (!isRetryableStatus(response.status) || attempt === attempts - 1) break;

    const delayMs = retryAfterMs(response.headers) ?? backoffMs(attempt, baseDelayMs);
    onRetry({ attempt, attempts, reason, delayMs });
    await sleep(delayMs);
  }

  throw lastError;
}
