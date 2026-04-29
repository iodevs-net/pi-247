import { describe, expect, it } from "bun:test";
import { checkContextPressure, CTX_WARN_PCT, CTX_CRITICAL_PCT } from "../src/context-guard";

describe("checkContextPressure", () => {
	it("returns proceed below warn threshold", () => {
		expect(checkContextPressure(0)).toBe("proceed");
		expect(checkContextPressure(CTX_WARN_PCT - 1)).toBe("proceed");
	});

	it("returns warn between warn and critical", () => {
		expect(checkContextPressure(CTX_WARN_PCT)).toBe("warn");
		expect(checkContextPressure(75)).toBe("warn");
		expect(checkContextPressure(CTX_CRITICAL_PCT - 1)).toBe("warn");
	});

	it("returns compact at and above critical", () => {
		expect(checkContextPressure(CTX_CRITICAL_PCT)).toBe("compact");
		expect(checkContextPressure(95)).toBe("compact");
		expect(checkContextPressure(99)).toBe("compact");
	});
});
