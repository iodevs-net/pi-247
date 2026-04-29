/**
 * Exponential backoff retry helper. DRY pattern for reconnect logic.
 *
 * Usage:
 *   await withRetry(() => bot.start(), { maxAttempts: 5 });
 */

export interface RetryOptions {
	/** Max retry attempts (default: 5) */
	maxAttempts?: number;
	/** Base delay in ms (default: 1000). Actual delay = base * 2^attempt */
	baseMs?: number;
	/** Max delay cap in ms (default: 30000) */
	maxMs?: number;
	/** Optional predicate to skip retry for non-retryable errors */
	isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_OPTS: Required<RetryOptions> = {
	maxAttempts: 5,
	baseMs: 1000,
	maxMs: 30_000,
	isRetryable: () => true,
};

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
	const { maxAttempts, baseMs, maxMs, isRetryable } = { ...DEFAULT_OPTS, ...opts };

	let lastErr: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err)) throw err;
			if (attempt === maxAttempts - 1) break;
			const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
			console.debug(`[retry] attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${delay}ms`);
			await sleep(delay);
		}
	}
	throw lastErr;
}
