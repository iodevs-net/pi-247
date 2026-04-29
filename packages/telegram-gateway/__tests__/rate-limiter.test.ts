import { describe, it, expect } from "bun:test";
import { RateLimiter } from "../src/rate-limiter";

describe("RateLimiter", () => {
	it("allows first request", () => {
		const rl = new RateLimiter({ maxRequests: 3 });
		expect(rl.allow("a")).toBe(true);
	});

	it("blocks after exceeding max", () => {
		const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
		expect(rl.allow("a")).toBe(true);
		expect(rl.allow("a")).toBe(true);
		expect(rl.allow("a")).toBe(false);
	});

	it("allows different keys independently", () => {
		const rl = new RateLimiter({ maxRequests: 1 });
		expect(rl.allow("a")).toBe(true);
		expect(rl.allow("a")).toBe(false);
		expect(rl.allow("b")).toBe(true);
	});

	it("resets key on reset()", () => {
		const rl = new RateLimiter({ maxRequests: 1 });
		rl.allow("a");
		expect(rl.allow("a")).toBe(false);
		rl.reset("a");
		expect(rl.allow("a")).toBe(true);
	});

	it("reports remaining count", () => {
		const rl = new RateLimiter({ maxRequests: 5 });
		expect(rl.remaining("a")).toBe(5);
		rl.allow("a");
		expect(rl.remaining("a")).toBe(4);
		rl.allow("a");
		rl.allow("a");
		rl.allow("a");
		rl.allow("a");
		rl.allow("a");
		expect(rl.remaining("a")).toBe(0);
	});

	it("tracks store size", () => {
		const rl = new RateLimiter({ maxRequests: 5 });
		rl.allow("a");
		rl.allow("b");
		expect(rl.size).toBe(2);
	});

	it("uses defaults when no opts given", () => {
		const rl = new RateLimiter();
		for (let i = 0; i < 10; i++) rl.allow("x");
		expect(rl.allow("x")).toBe(false);
	});

	it("recovers after window expires", async () => {
		const rl = new RateLimiter({ maxRequests: 1, windowMs: 50 });
		expect(rl.allow("a")).toBe(true);
		expect(rl.allow("a")).toBe(false);
		await sleep(60);
		expect(rl.allow("a")).toBe(true);
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}
