import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Permission = "connectors" | "web" | "writes";
export type Policy = "ask" | "allow" | "deny";
const ENV: Record<Permission, string> = {
	connectors: "PI_CODEX_CONNECTORS_DATA",
	web: "PI_CODEX_WEB_SEARCH_DATA",
	writes: "PI_CODEX_CONNECTORS_WRITES",
};
const KEYS: Permission[] = ["connectors", "web", "writes"];
const isPolicy = (value: unknown): value is Policy => value === "ask" || value === "allow" || value === "deny";

function settingsPath(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const base = configured ? (configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured)
		: join(homedir(), ".pi", "agent");
	return join(base, "codex-connectors-permissions.json");
}

function readPermissions(): Partial<Record<Permission, Policy>> {
	try {
		const settings: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
		if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
			Object.entries(settings).some(([key, value]) => !KEYS.includes(key as Permission) || !isPolicy(value))) throw new Error();
		return settings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Could not read saved Codex permissions. Check codex-connectors-permissions.json in your Pi user directory; private diagnostics were withheld.");
	}
}

/** Environment overrides saved preferences. Read on each call so revocation takes effect immediately. */
export function permissionPolicy(permission: Permission): Policy {
	const override = process.env[ENV[permission]];
	if (override !== undefined) return isPolicy(override) ? override : "ask";
	return readPermissions()[permission] ?? "ask";
}

export function hasPermissionOverride(permission: Permission): boolean {
	return process.env[ENV[permission]] !== undefined;
}

/** Store policies only, never credentials, queries, or tool arguments. */
export function savePermissions(update: Partial<Record<Permission, Policy>>): void {
	const settings = { ...readPermissions(), ...update };
	const path = settingsPath();
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch {
		throw new Error("Could not save Codex permissions. Check your Pi user directory permissions; private diagnostics were withheld.");
	} finally {
		try { rmSync(temporary, { force: true }); } catch { /* Never expose a private filesystem error. */ }
	}
}

export function registerPermissions(pi: ExtensionAPI) {
	pi.registerCommand("codex-permissions", {
		description: "Save user-wide permissions: [all|data|connectors|web|writes] [allow|ask|deny]. all includes writes.",
		handler: async (args, ctx) => {
			try {
				if (args.trim()) {
					const [scope, policy, extra] = args.trim().split(/\s+/);
					const keys = scope === "all" ? KEYS : scope === "data" ? ["connectors", "web"] as const
						: KEYS.includes(scope as Permission) ? [scope as Permission] : [];
					if (!keys.length || !isPolicy(policy) || extra) throw new Error("Usage: /codex-permissions [all|data|connectors|web|writes] [allow|ask|deny]. all includes connected-app writes.");
					savePermissions(Object.fromEntries(keys.map((key) => [key, policy])));
				}
				ctx.ui.notify(`Codex permissions (saved across sessions):\n${KEYS.map((key) => `${key}: ${permissionPolicy(key)}${hasPermissionOverride(key) ? " (environment override)" : ""}`).join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Could not update Codex permissions.", "error");
			}
		},
	});
}
