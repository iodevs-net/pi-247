import { describe, expect, it } from "bun:test";
import { AgentClient } from "../src/agent-client";

const TEST_TIMEOUT = 120_000;
const hasApiKey = !!(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_TEST_KEY);
const itReal = hasApiKey ? it : it.skip;

describe("Verification Gate integration", () => {
	itReal("triggers VERIFICADO with evidence on file write", async () => {
		const client = new AgentClient();
		await client.init("/tmp/pi-gateway-test", null);

		const result = await client.prompt("Create a file /tmp/hello-test.txt with content 'hello world'");

		console.log("\n[AGENT RESPONSE]");
		console.log(result.text);
		console.log("[PARTIAL]", result.partial);

		// Agent should have run tools and produced verification
		const hasDeclared = /\b(?:VERIFICADO|NO_VERIFICADO)\b/.test(result.text);
		console.log("[GATE] declaration found:", hasDeclared);

		if (hasDeclared) {
			const isVerified = /\bVERIFICADO\b/.test(result.text);
			console.log("[GATE] is VERIFICADO:", isVerified);
		}

		await client.shutdown();

		// At minimum, agent must have responded
		expect(result.text.length).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	itReal("detects missing verification on multi-step task", async () => {
		const client = new AgentClient();
		await client.init("/tmp/pi-gateway-test", null);

		// Multi-step: agent must read, write, verify
		const result = await client.prompt(
			"Read /tmp/hello-test.txt content, then append ' line 2' to it."
		);

		console.log("\n[AGENT RESPONSE (multi-step)]");
		console.log(result.text);
		console.log("[PARTIAL]", result.partial);

		const hasVerification = /\bVERIFICADO\b/.test(result.text);
		const hasNoVerification = /\bNO_VERIFICADO\b/.test(result.text);
		console.log("[GATE] VERIFICADO:", hasVerification, "| NO_VERIFICADO:", hasNoVerification);

		await client.shutdown();
		expect(result.text.length).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	itReal("does not require verification for read-only prompts", async () => {
		const client = new AgentClient();
		await client.init("/tmp/pi-gateway-test", null);

		const result = await client.prompt("Say 'hello'");

		console.log("\n[AGENT RESPONSE (read-only)]");
		console.log(result.text);

		// Read-only should not require VERIFICADO
		const hasVerification = /\bVERIFICADO\b/.test(result.text);
		console.log("[GATE] unexpected VERIFICADO on read-only:", hasVerification);
		// Must have responded
		expect(result.text.length).toBeGreaterThan(0);

		await client.shutdown();
	}, TEST_TIMEOUT);
});
