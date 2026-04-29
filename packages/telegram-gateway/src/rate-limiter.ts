/**
 * Sliding window rate limiter. Per-key, in-memory, no dependencies.
 * Evicts stale entries on access (no background timer needed).
 */

export interface RateLimiterOptions {
	/** Max requests per window (default: 10) */
	maxRequests: number;
	/** Window duration in ms (default: 60000 = 1 min) */
	windowMs: number;
}

interface Entry {
	/** Window start timestamp */
	windowStart: number;
	/** Tokens consumed this window */
	count: number;
}

export class RateLimiter {
	private store = new Map<string, Entry>();
	private max: number;
	private windowMs: number;

	constructor(opts?: Partial<RateLimiterOptions>) {
		this.max = opts?.maxRequests ?? 10;
		this.windowMs = opts?.windowMs ?? 60_000;
	}

	/**
	 * Check if `key` is allowed. Returns true if under limit.
	 * Consumes one token on check.
	 */
	allow(key: string): boolean {
		const now = Date.now();
		const entry = this.store.get(key);

		if (!entry || now - entry.windowStart >= this.windowMs) {
			this.store.set(key, { windowStart: now, count: 1 });
			return true;
		}

		entry.count++;
		if (entry.count > this.max) {
			return false;
		}

		return true;
	}

	/**
	 * Reset state for a key (e.g., after /reset command).
	 */
	reset(key: string): void {
		this.store.delete(key);
	}

	/**
	 * Remaining tokens in current window for a key. 0 if over limit.
	 */
	remaining(key: string): number {
		const entry = this.store.get(key);
		if (!entry) return this.max;
		if (Date.now() - entry.windowStart >= this.windowMs) return this.max;
		return Math.max(0, this.max - entry.count);
	}

	/** Total tracked keys (for monitoring). */
	get size(): number {
		return this.store.size;
	}
}
