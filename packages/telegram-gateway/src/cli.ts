/**
 * pi-247 CLI — run agent prompts from terminal
 *
 * Usage:
 *   p247 <prompt>
 *   p247 "create a file with hello world"
 *
 * Env:
 *   DEEPSEEK_API_KEY             API key for the agent model
 *   GATEWAY_AGENT_CWD            Working directory (default: cwd)
 *   GATEWAY_AGENT_DIR            Config dir (default: ~/.omp/pi-gateway)
 */

import { AgentClient } from "./agent-client";

async function main(): Promise<void> {
	const prompt = process.argv[2];
	if (!prompt) {
		console.error("Usage: p247 <prompt>");
		console.error('  p247 "explain what this project does"');
		process.exit(1);
	}

	const agentDir = process.env.GATEWAY_AGENT_DIR ?? undefined;
	const agentCwd = process.env.GATEWAY_AGENT_CWD ?? process.cwd();

	const agent = new AgentClient();
	await agent.init(agentCwd, null, agentDir);

	try {
		const result = await agent.prompt(prompt);
		console.log(`\n${result.text}`);
	} finally {
		await agent.shutdown();
	}
}

main().catch((err: Error) => {
	console.error("[p247] fatal:", err.message);
	process.exit(1);
});
