import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi themes color components, but leave the terminal's default canvas alone.
// This zero-height widget synchronizes only this Pi terminal session, including
// theme previews, and restores the terminal's configured defaults on exit/reload.
const palettes: Record<string, [string, string, string]> = {
	"rose-pine": ["#e0def4", "#191724", "#ebbcba"],
	"rose-pine-moon": ["#e0def4", "#232136", "#ea9a97"],
	"rose-pine-dawn": ["#575279", "#faf4ed", "#b4637a"],
};
const reset = "\x1b]110\x07\x1b]111\x07\x1b]112\x07";

export default function (pi: ExtensionAPI) {
	let applied: string | undefined;
	let write: ((text: string) => void) | undefined;
	let current: ExtensionContext | undefined;
	const restore = () => {
		if (applied) write?.(reset);
		applied = undefined;
	};
	const cleanup = () => {
		restore();
		process.removeListener("exit", restore);
		current?.ui.setWidget("rose-pine-palette", undefined);
		current = undefined;
		write = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		cleanup();
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		if (!ctx.hasUI || (mode !== undefined && mode !== "tui") || !process.stdout.isTTY || process.env.TERM === "dumb") return;
		current = ctx;
		process.once("exit", restore);
		ctx.ui.setWidget("rose-pine-palette", (tui) => {
			write = (text) => tui.terminal.write(text);
			return {
				render() {
					const name = ctx.ui.theme.name ?? "";
					if (name !== applied) {
						const palette = palettes[name];
						if (palette) {
							write?.(palette.map((color, i) => `\x1b]${10 + i};${color}\x07`).join(""));
							applied = name;
						} else restore();
					}
					return [];
				},
				invalidate() {},
			};
		});
	});
	pi.on("session_shutdown", cleanup);
}
