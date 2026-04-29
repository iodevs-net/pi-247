import { describe, expect, it } from "bun:test";
import { hasVerificationEvidence } from "../src/evidence";

describe("hasVerificationEvidence", () => {
	it("detects bun test summary with pass/fail counts", () => {
		const output = `bun test v1.3.11
 23 pass
 0 fail
 27 expect() calls
Ran 23 tests across 1 file. [92.00ms]`;
		expect(hasVerificationEvidence(output)).toBe(true);
	});

	it("detects bun test checkmarks", () => {
		expect(hasVerificationEvidence("✓ should reject prompt before init")).toBe(true);
		expect(hasVerificationEvidence("× should reject prompt before init")).toBe(true);
	});

	it("detects TypeScript compiler errors", () => {
		expect(hasVerificationEvidence("src/file.ts:1:1 - error TS2304: Cannot find name 'foo'")).toBe(true);
		expect(hasVerificationEvidence("error TS2345: Argument of type 'X' is not assignable to 'Y'")).toBe(true);
	});

	it("detects git diff hunk headers", () => {
		const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,6 @@
 class Foo {
+  bar: string;
   baz: number;
 }`;
		expect(hasVerificationEvidence(diff)).toBe(true);
	});

	it("detects diff line changes", () => {
		const diff = `-old code
+new code`;
		expect(hasVerificationEvidence(diff)).toBe(true);
	});

	it("detects build succeeded/failed", () => {
		expect(hasVerificationEvidence("Build succeeded")).toBe(true);
		expect(hasVerificationEvidence("build failed")).toBe(true);
	});

	it("returns false for normal conversational text", () => {
		const text = "He verificado los cambios y todo funciona correctamente.";
		expect(hasVerificationEvidence(text)).toBe(false);
	});

	it("returns false for VERIFICADO declaration alone", () => {
		const text = "VERIFICADO: los tests pasaron correctamente";
		expect(hasVerificationEvidence(text)).toBe(false);
	});

	it("returns false for NO_VERIFICADO declaration", () => {
		const text = "NO_VERIFICADO: no se pudo ejecutar el test. RIESGO: posible regression";
		expect(hasVerificationEvidence(text)).toBe(false);
	});

	it("returns false for empty text", () => {
		expect(hasVerificationEvidence("")).toBe(false);
	});

	it("returns false for code snippets without test output", () => {
		const code = "function add(a: number, b: number): number {\n  return a + b;\n}";
		expect(hasVerificationEvidence(code)).toBe(false);
	});

	it("returns true when evidence embedded in longer text", () => {
		const text = `Some explanation of changes.

Then verification output:
 23 pass
 0 fail

VERIFICADO: tests pasan → 23/23`;
		expect(hasVerificationEvidence(text)).toBe(true);
	});

	it("handles bun test with failures", () => {
		const output = `bun test v1.3.11

src/file.test.ts:
 1 pass
 2 fail
 3 expect() calls

Ran 3 tests across 1 file. [150ms]`;
		expect(hasVerificationEvidence(output)).toBe(true);
	});

	it("returns false for just the word 'pass' in text", () => {
		expect(hasVerificationEvidence("This should pass review")).toBe(false);
	});

	it("returns false for just the word 'fail' in text", () => {
		expect(hasVerificationEvidence("This change should not fail")).toBe(false);
	});
});
