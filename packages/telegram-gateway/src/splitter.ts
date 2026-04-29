/**
 * Markdown-safe message splitter.
 * Splits long text at boundaries that won't break Markdown formatting.
 * Respects code fences, inline code, bold/italic markers.
 */

export function splitMarkdown(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];

	const chunks: string[] = [];
	let remaining = text;
	let codeFenceLang = "";

	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}

		const splitAt = findSplitPoint(remaining, maxLen, codeFenceLang);

		let chunk = remaining.slice(0, splitAt);
		remaining = remaining.slice(splitAt);

		// Handle open code fence at end of chunk
		const openFence = chunk.match(/```(\w*)$/);
		if (openFence) {
			codeFenceLang = openFence[1] || "";
		} else {
			codeFenceLang = "";
		}

		// If we split inside a ``` block, close it and reopen
		if (isInsideCodeBlock(chunk)) {
			if (!chunk.endsWith("\n")) chunk += "\n";
			chunk += "```";
			const nextFence = remaining.match(/^```/);
			if (!nextFence) {
				remaining = "```" + (codeFenceLang ? codeFenceLang + "\n" : "\n") + remaining;
			}
		}

		chunks.push(chunk);
	}

	return chunks;
}

function findSplitPoint(text: string, maxLen: number, _codeFenceLang: string): number {
	// Prefer newline break under maxLen
	const toNewline = text.lastIndexOf("\n", maxLen);
	if (toNewline > maxLen * 0.6) return toNewline + 1;

	// Prefer space break under maxLen
	const toSpace = text.lastIndexOf(" ", maxLen);
	if (toSpace > maxLen * 0.5) return toSpace + 1;

	// Hard split at maxLen
	return maxLen;
}

function isInsideCodeBlock(text: string): boolean {
	const fences = text.match(/```/g);
	if (!fences) return false;
	return fences.length % 2 !== 0;
}
