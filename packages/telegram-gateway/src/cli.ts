/**
 * pi-247 CLI — run agent prompts from terminal
 *
 * Usage:
 *   p247 <prompt>          One-shot prompt
 *   p247 --chat            Interactive REPL session
 *   p247                   Interactive REPL (default sin args)
 *
 * Env:
 *   DEEPSEEK_API_KEY             API key for the agent model
 *   GATEWAY_AGENT_CWD            Working directory (default: cwd)
 *   GATEWAY_AGENT_DIR            Config dir (default: ~/.omp/pi-gateway)
 */

import { createInterface } from "readline";
import { AgentClient } from "./agent-client";

function showBanner(): void {
	console.log("");
	console.log("  ╭──────────────────────────────╮");
	console.log("  │  pi-247 — interactive chat   │");
	console.log("  │  /exit o Ctrl+C para salir   │");
	console.log("  ╰──────────────────────────────╯");
	console.log("");
}

async function repl(agent: AgentClient): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "\x1b[36mp247>\x1b[0m ",
	});

	showBanner();
	rl.prompt();

	for await (const line of rl) {
		const trimmed = line.trim();

		if (!trimmed) {
			rl.prompt();
			continue;
		}

		if (trimmed === "/exit" || trimmed === "/quit") {
			console.log("bye");
			break;
		}

		if (trimmed === "/reset") {
			await agent.shutdown();
			await agent.init(process.env.GATEWAY_AGENT_CWD ?? process.cwd(), null, process.env.GATEWAY_AGENT_DIR ?? undefined);
			console.log("sesion reiniciada\n");
			rl.prompt();
			continue;
		}

		try {
			const result = await agent.prompt(trimmed);
			console.log(`\n${result.text}`);
			if (result.partial) {
				console.log("\n\x1b[33m[respuesta parcial — la sesion continua]\x1b[0m");
			}
		} catch (err) {
			console.error("\x1b[31m[p247 error]\x1b[0m", (err as Error).message);
		}

		console.log("");
		rl.prompt();
	}

	rl.close();
}

async function main(): Promise<void> {
	const agentDir = process.env.GATEWAY_AGENT_DIR ?? undefined;
	const agentCwd = process.env.GATEWAY_AGENT_CWD ?? process.cwd();
	const isChat = !process.argv[2] || process.argv[2] === "--chat" || process.argv[2] === "-i";

	const agent = new AgentClient();
	await agent.init(agentCwd, null, agentDir);

	try {
		if (isChat) {
			await repl(agent);
		} else {
			const result = await agent.prompt(process.argv[2]);
			console.log(`\n${result.text}`);
		}
	} finally {
		await agent.shutdown();
	}
}

main().catch((err: Error) => {
	console.error("[p247] fatal:", err.message);
	process.exit(1);
});
