import { describe, it, expect } from "bun:test";
import { splitMarkdown } from "../src/splitter";

describe("splitMarkdown", () => {
	it("returns single chunk for short text", () => {
		const r = splitMarkdown("hello world", 100);
		expect(r).toEqual(["hello world"]);
	});

	it("splits at newline boundary", () => {
		const text = "aaa\nbbb\nccc\nddd";
		const r = splitMarkdown(text, 8);
		expect(r.length).toBeGreaterThan(1);
		expect(r.join("")).toBe(text);
	});

	it("splits at space boundary when no newline", () => {
		const text = "hello world foo bar baz";
		const r = splitMarkdown(text, 12);
		expect(r).toEqual(["hello world ", "foo bar baz"]);
	});

	it("hard splits at maxLen when no boundary", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const r = splitMarkdown(text, 10);
		expect(r).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
	});

	it("preserves code fence boundaries", () => {
		const text = "text\n```\nlong code block content here\n```\nend";
		const r = splitMarkdown(text, 20);
		for (const chunk of r) {
			expect(isCodeBlockBalanced(chunk)).toBe(true);
		}
	});

	it("handles empty string", () => {
		expect(splitMarkdown("", 10)).toEqual([""]);
	});

	it("handles single chunk exactly at maxLen", () => {
		const text = "1234567890";
		expect(splitMarkdown(text, 10)).toEqual(["1234567890"]);
	});

	it("returns multiple chunks preserving total content", () => {
		const text = "a".repeat(100);
		const r = splitMarkdown(text, 30);
		expect(r.length).toBeGreaterThan(1);
		expect(r.join("")).toBe(text);
	});
});

function isCodeBlockBalanced(text: string): boolean {
	const fences = text.match(/```/g);
	return !fences || fences.length % 2 === 0;
}
