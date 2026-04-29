import path from "path";
import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { debug, log } from "./debug";
import { detectToolLoop, stableStringify } from "./loop-detection";
import { hasVerificationEvidence } from "./evidence";

export interface PromptResult {
	text: string;
	partial: boolean;
}

interface QueueItem {
	text: string;
	resolve: (r: PromptResult) => void;
	reject: (err: unknown) => void;
}

const PROMPT_TIMEOUT_MS = parseInt(process.env.GATEWAY_PROMPT_TIMEOUT ?? "120000", 10);
const MAX_QUEUE_SIZE = parseInt(process.env.GATEWAY_MAX_QUEUE ?? "20", 10);

function buildSystemPrompt(cwd: string): (defaultPrompt: string) => string {
	const workspaceDir = path.join(cwd, "workspace");

	return (defaultPrompt: string) => `${defaultPrompt}

## Identity & Workspace

Eres **pi-247**, un ingeniero de software senior full stack experto. Tu workspace para pruebas y experimentos es: \`${workspaceDir}\`

- Usa \`workspace/\` para crear archivos temporales, descargar repos, experimentos.
- No modifiques directorios del proyecto real (src/, packages/) sin autorización explicita.
- Revisa workspace/README.md para reglas completas.

## Metodología de Trabajo

Sigue estos pasos en orden para CADA problema:

1. **Pareto (80/20)**: Identifica el 20% del código responsable del 80% del problema.
2. **5 Porqués**: Profundiza hasta encontrar la causa raíz real.
3. **95% Certeza**: NO hagas cambios hasta tener 95% de certeza de la solución. Si tienes dudas, investiga más.
4. **Investigación**: Usa web search con Context7 y Tavily/Brave para documentación actualizada de librerías/APIs.
5. **Solución Atómica**: Cambio quirúrgico, mínimo, que resuelve la causa raíz sin efectos secundarios.

## Loop Detection & Auto-Correction

Debes auto-monitorearte para detectar loops. Un loop = misma herramienta con mismos argumentos ≥3 veces seguidas SIN progreso hacia el objetivo.

### Protocolo de Loop

1. **Al detectar un loop (1ra vez)**: Di "EN_LOOP:1" y cambia de estrategia IMMEDIATAMENTE. No sigas haciendo lo mismo.
2. **Si la nueva estrategia también loopa (2da vez)**: Di "EN_LOOP:2" y vuelve a cambiar. Es tu ÚLTIMA autosolución.
3. **Si aún así loopas (3ra vez)**: Di "ESCALANDO" seguido de 2-3 frases explicando el problema al usuario. Espera instrucciones.

### Estrategias para Romper Loops

- Cambia de herramienta (si usaste bash, prueba web search)
- Descompón el problema en sub-pasos más pequeños
- Intenta un enfoque completamente diferente
- Si es un error de API, prueba con parámetros diferentes

## Verification Gate Protocol (OBLIGATORIO)

Antes de declarar una tarea como completa DEBES verificar.

### Cuándo verificar

- Si ejecutaste herramientas que modifican archivos (Write, Edit, Bash con sed/echo >, etc.) → verificacion OBLIGATORIA.
- Si solo leiste o respondiste sin cambios → responde "NO_VERIFICADO: sin cambios".

### Protocolo

1. **LEE** el diff de tus cambios: \`git diff\` o revisa los archivos modificados.
2. **TESTEA**: Corre tests o validacion relevante (typecheck, build, linter).
3. **DECLARA** al FINAL de tu respuesta, en linea separada:
   - \`VERIFICADO: [que se verifico] → [resultado]\`
   - \`NO_VERIFICADO: [que no se pudo verificar]. RIESGO: [impacto potencial]\`

Sin declaracion de verificacion la tarea NO esta completa. El gateway reintentara automaticamente.

## Estilo de Código

- **DRY**: No repitas lógica. Abstrae solo cuando se repite 3+ veces.
- **LEAN**: Mínimas dependencias. APIs nativas primero.
- **SOLID**: Separación clara de responsabilidades.
- **KISS**: 10 líneas simples > 50 líneas de abstracción "perfecta".
- **Zero AI Slop**: Sin comentarios superfluos, sin "espero que esto ayude", sin descripciones de lo obvio.
- **Stack existente**: Respeta TypeScript, Bun, estructura del monorepo. No cambies estilo o convenciones del código existente.

## Telegram Communication Rules

You are responding via Telegram messenger. Follow these rules:
- **Ultra concise**: 2-4 sentences max. No introductions, no farewells.
- **State intent first**: "Revisando logs..." "Buscando en web..." then result.
- **No narration**: Don't describe what you're doing step by step. Just do it.
- **Markdown**: Use *bold* for commands/paths, \`code\` for snippets.
- **No disclaimers**: No "let me know if you need anything else", "hope this helps", etc.
- **One message**: Send complete result in single message unless >4000 chars.`;
}

/** Severity of detected loop */
type LoopSeverity = "ok" | "loop" | "escalate";

/**
 * Wraps pi-247 AgentSession with Promise-based prompt/response API.
 * Maintains conversation context. Queues messages when agent busy.
 */
export class AgentClient {
	private session: AgentSession | null = null;
	private processing = false;
	private queue: QueueItem[] = [];
	private idleWaiters: Array<() => void> = [];

	get isBusy(): boolean {
		return this.processing;
	}

	async init(cwd: string, sessionDir: string | null, agentDir?: string): Promise<void> {
		log("agent", "starting pi-247 session (cwd=%s)", cwd);
		debug("agent", "init with sessionDir=%s agentDir=%s", sessionDir ?? "null", agentDir ?? "default");

		const opts: Record<string, unknown> = { cwd };
		if (agentDir) {
			opts.agentDir = agentDir;
		}
		if (sessionDir) {
			opts.sessionManager = await SessionManager.continueRecent(cwd, sessionDir);
		}
		opts.systemPrompt = buildSystemPrompt(cwd);

		const result = await createAgentSession(opts as Parameters<typeof createAgentSession>[0]);
		this.session = result.session;

		if (result.modelFallbackMessage) {
			console.warn("[agent] %s", result.modelFallbackMessage);
		}

		console.log("[agent] session ready");
	}

	/**
	 * Send a prompt to the agent. Queues if busy, processes sequentially.
	 * Resolves when the agent finishes responding.
	 */
	async prompt(text: string): Promise<PromptResult> {
		if (!this.session) throw new Error("AgentClient not initialized. Call init() first.");

		const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;

		if (this.processing) {
			if (this.queue.length >= MAX_QUEUE_SIZE) {
				const err = new Error(`Queue full (max ${MAX_QUEUE_SIZE}). Try again later.`);
				debug("queue", "QUEUE FULL: %s", preview);
				throw err;
			}
			debug("queue", "QUEUE +%d: %s", this.queue.length + 1, preview);
			return new Promise((resolve, reject) => {
				this.queue.push({ text, resolve, reject });
			});
		}

		debug("agent", "EXEC (idle): %s", preview);
		return this.executePrompt(text);
	}

	private async executePrompt(text: string): Promise<PromptResult> {
		this.processing = true;
		try {
			return await this.runPrompt(text);
		} finally {
			this.processing = false;
			this.notifyIdleWaiters();
			this.dequeue();
		}
	}

	/**
	 * Monitor a single turn cycle via subscription. Returns the assistant text
	 * and detected loop severity from tool call patterns.
	 */
	private waitForTurn(session: AgentSession, turnPrompt: string): Promise<{
		text: string;
		partial: boolean;
		loopSeverity: LoopSeverity;
		toolCallHistory: string;
		toolCallEntries: Array<{ tool: string; key: string }>;
	}> {
		const toolCalls: Array<{ tool: string; key: string }> = [];

		return new Promise((resolve, reject) => {
			const parts: string[] = [];
			let partial = false;
			let toolUsePending = false;
			let settled = false;
			let loopSeverity: LoopSeverity = "ok";
			let turnData: {
				text: string;
				partial: boolean;
				loopSeverity: LoopSeverity;
				toolCallHistory: string;
				toolCallEntries: Array<{ tool: string; key: string }>;
			} | null = null;
			let promptDone = false;

			const timer = setTimeout(() => {
				settled = true;
				reject(new Error(`Prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`));
			}, PROMPT_TIMEOUT_MS);

			function finalize() {
				if (!turnData || !promptDone) return;
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				resolve(turnData);
			}

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (settled) return;

				if (event.type === "message_update" && "assistantMessageEvent" in event) {
					const ev = event as { assistantMessageEvent?: { type?: string; delta?: string } };
					if (ev.assistantMessageEvent?.type === "text_delta" && ev.assistantMessageEvent.delta) {
						parts.push(ev.assistantMessageEvent.delta);
					}
				}

				if (event.type === "message_end") {
					const msg = (event as { message?: { role?: string; content?: Array<{ type: string; text: string }>; stopReason?: string } }).message;
					if (msg?.role === "assistant") {
						if (msg.content && Array.isArray(msg.content)) {
							const fullText = msg.content
								.filter(c => c?.type === "text")
								.map(c => c.text)
								.join("");
							if (fullText) {
								parts.length = 0;
								parts.push(fullText);
							}
						}
						if (msg.stopReason === "error" || msg.stopReason === "aborted") {
							partial = true;
						}
						if (msg.stopReason === "toolUse" && msg.content) {
							toolUsePending = true;
							// Track which tools are called for loop detection
							for (const block of msg.content as Array<Record<string, unknown>>) {
								const tu = block.toolUse as { name?: string; arguments?: Record<string, unknown> } | undefined;
								if (tu?.name) {
									const toolName = tu.name;
									const argsKey = stableStringify(tu.arguments ?? {});
									toolCalls.push({ tool: toolName, key: argsKey });

									const detection = detectToolLoop(toolCalls);
									if (detection.isLoop) {
										loopSeverity = "loop";
										debug("loop", "tool loop: %s(%s)", toolName, argsKey);
									}
								}
							}
						}
					}
				}

				if (event.type === "turn_end") {
					if (toolUsePending) {
						toolUsePending = false;
						return;
					}
					const toolCallHistory = toolCalls.map(t => `${t.tool}(${t.key})`).join(" | ");
					turnData = {
						text: parts.join("").trim(),
						partial,
						loopSeverity,
						toolCallHistory,
						toolCallEntries: [...toolCalls],
					};
					finalize();
				}
			});

			session.prompt(turnPrompt).then(() => {
				promptDone = true;
				finalize();
			}).catch((err: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				reject(err);
			});
		});
	}

	private async runPrompt(text: string): Promise<PromptResult> {
		const session = this.session!;
		let combinedText = "";
		let loopCount = 0;
		const MAX_GATEWAY_INTERVENTIONS = 4;
		let currentText = text;

		for (let attempt = 0; attempt <= MAX_GATEWAY_INTERVENTIONS; attempt++) {
			const result = await this.waitForTurn(session, currentText);
			combinedText += (combinedText ? "\n\n" : "") + result.text;

			// 1. Loop detection intervention
			if (result.loopSeverity === "loop" && attempt < MAX_GATEWAY_INTERVENTIONS) {
				loopCount++;
				log("loop", "intervening #%d after detecting tool repetition", loopCount);

				if (/ESCALANDO/i.test(result.text)) {
					log("loop", "agent already escalated, not re-intervening");
					return { text: combinedText, partial: false };
				}

				const strategies = [
					"[SISTEMA: Estas repitiendo la misma herramienta. Cambia de estrategia IMMEDIATAMENTE. Prueba otro enfoque completamente diferente.]",
					"[SISTEMA: Sigue en loop. Es tu ULTIMA oportunidad de auto-correccion. Si no puedes resolverlo, di ESCALANDO y explica el problema.]",
				];
				currentText = strategies[Math.min(loopCount - 1, strategies.length - 1)];
				continue;
			}

			// 2. Verification Gate
			if (result.toolCallEntries.length > 0 && attempt < MAX_GATEWAY_INTERVENTIONS) {
				const isVerified = /\bVERIFICADO\b/.test(result.text);
				const isNoVerified = /\bNO_VERIFICADO\b/.test(result.text);

				if (isNoVerified) {
					// Honest declaration — no evidence needed
					return { text: combinedText, partial: result.partial };
				}

				if (isVerified) {
					// Check for real evidence in response
					if (hasVerificationEvidence(result.text)) {
						return { text: combinedText, partial: result.partial };
					}
					log("gate", "VERIFICADO without evidence, intervening (attempt %d)", attempt);
					currentText = "[SISTEMA: Declaraste VERIFICADO pero no hay evidencia de verificacion (output de test/diff/build). Ejecuta el comando correspondiente y muestra el output REAL.]";
					continue;
				}

				// No verification declaration at all
				log("gate", "missing verification declaration, intervening (attempt %d)", attempt);
				currentText = "[SISTEMA: No se detecto declaracion VERIFICADO/NO_VERIFICADO. Ejecuta el protocolo Verification Gate obligatorio.]";
				continue;
			}

			return { text: combinedText, partial: result.partial };
		}

		return { text: combinedText, partial: false };
	}

	private dequeue(): void {
		if (this.queue.length === 0) return;
		const next = this.queue.shift()!;
		this.executePrompt(next.text).then(next.resolve).catch(next.reject);
	}

	private notifyIdleWaiters(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const w of waiters) w();
	}

	async waitForIdle(): Promise<void> {
		if (!this.processing) return;
		return new Promise(resolve => {
			this.idleWaiters.push(resolve);
		});
	}

	async shutdown(): Promise<void> {
		log("agent", "shutting down (queue=%d, processing=%s)", this.queue.length, this.processing);
		if (this.session) {
			try {
				await this.session.prompt("/reset");
			} catch {
				// ignore
			}
			this.session = null;
		}
	}
}
