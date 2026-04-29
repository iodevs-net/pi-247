/** Ultra-detailed debug logger. Active when DEBUG=true or DEBUG=pi-gateway. */

const active =
	["true", "1", "pi-gateway", "pi-gateway:*", "*"].includes(process.env.DEBUG ?? "")
	|| (process.env.DEBUG?.split(",")?.some(s => {
		const t = s.trim();
		return t === "pi-gateway" || t === "pi-gateway:*" || t === "*";
	}) ?? false);

function ts(): string {
	const d = new Date();
	return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// Always-on prefix for all output
export function log(area: string, msg: string, ...args: unknown[]): void {
	console.log(`[${ts()}] [${area}] ${msg}`, ...args);
}

// Debug-only: verbatim data dumps
export function debug(area: string, msg: string, ...args: unknown[]): void {
	if (!active) return;
	console.debug(`[${ts()}] [DEBUG:${area}] ${msg}`, ...args);
}

// Dump an object as JSON with optional label
export function dump(area: string, label: string, obj: unknown): void {
	if (!active) return;
	try {
		const json = JSON.stringify(obj, null, 2);
		console.debug(`[${ts()}] [DEBUG:${area}] === ${label} ===\n${json}\n=== end ${label} ===`);
	} catch {
		console.debug(`[${ts()}] [DEBUG:${area}] ${label}: (non-serializable)`, obj);
	}
}

// Error with full stack
export function error(area: string, msg: string, err: unknown): void {
	console.error(`[${ts()}] [ERROR:${area}] ${msg}`, err instanceof Error ? err.stack ?? err.message : err);
}
