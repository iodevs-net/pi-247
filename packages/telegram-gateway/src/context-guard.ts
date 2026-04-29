export const CTX_WARN_PCT = 70;
export const CTX_CRITICAL_PCT = 90;

export type ContextAction = "proceed" | "warn" | "compact";

export function checkContextPressure(percent: number): ContextAction {
	if (percent >= CTX_CRITICAL_PCT) return "compact";
	if (percent >= CTX_WARN_PCT) return "warn";
	return "proceed";
}
