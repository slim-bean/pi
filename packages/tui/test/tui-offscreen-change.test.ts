import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MutableLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

// A frame taller than the terminal, so early lines sit above the viewport.
function tallFrame(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe("TUI changes above the viewport", () => {
	it("does not redraw when every changed line is above the viewport", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new MutableLines(tallFrame(40));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const redrawsBefore = tui.fullRedraws;
		const viewportBefore = terminal.getViewport();

		// Line 0 is far above the visible 10 rows. Nothing visible changes, so
		// the renderer must not clear the screen and reprint all 40 lines.
		content.lines[0] = "line 0 changed off screen";
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsBefore, "off-screen change must not force a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), viewportBefore, "visible rows must be unchanged");

		tui.stop();
	});

	it("repaints only the visible part when a change spans the viewport top", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new MutableLines(tallFrame(40));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const redrawsBefore = tui.fullRedraws;

		// Change an off-screen line and a visible one in the same frame: the
		// visible edit must land without reprinting the whole transcript.
		content.lines[0] = "line 0 changed off screen";
		content.lines[39] = "last line changed";
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsBefore, "partially visible change must not force a full redraw");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("last line changed")),
			"visible edit must be drawn",
		);

		tui.stop();
	});

	// Isolates the shrink clause of the clamp condition, with no earlier skip so
	// the resync path is inert. Clamping a shrinking frame repaints only from the
	// viewport top, leaving the window showing a partial frame padded with blanks
	// instead of the frame's last `rows` lines.
	it("keeps a full viewport when the frame shrinks and a line above it changes", async () => {
		const rows = 10;
		const terminal = new VirtualTerminal(40, rows);
		const tui = new TUI(terminal);
		const content = new MutableLines(tallFrame(40));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		content.lines = tallFrame(35);
		content.lines[5] = "line 5 changed off screen";
		tui.requestRender();
		await terminal.waitForRender();

		const expected = Array.from({ length: rows }, (_, i) => `line ${35 - rows + i}`);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trim()),
			expected,
			"viewport must show the frame's last rows, not a partial frame padded with blanks",
		);

		tui.stop();
	});

	// previousKittyImageIds is what the terminal is believed to hold, and
	// fullRender deletes exactly that set. Taking a fast path while adopting a new
	// set would drop the id of an image that is still on screen, so it could never
	// be deleted. An image change above the viewport must therefore fall back to a
	// full redraw rather than being skipped.
	it("falls back to a full redraw when an off-screen image changes", async () => {
		const kittyImage = (id: number) => `\x1b_Gi=${id},r=1;payload\x1b\\`;
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const lines = tallFrame(40);
		lines[3] = kittyImage(101);
		const content = new MutableLines(lines);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const redrawsBefore = tui.fullRedraws;

		// Replace the off-screen image with a different id: the old image is still
		// physically on screen, so its id must not be forgotten.
		content.lines[3] = kittyImage(202);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > redrawsBefore, "an off-screen image change must not take the skip/clamp fast path");

		tui.stop();
	});

	it("restores skipped lines when the frame shrinks back over them", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new MutableLines(tallFrame(40));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		// Viewport shows lines 30..39. Change line 25: above the viewport, so its
		// repaint is skipped and the terminal row for it is never written.
		content.lines[25] = "line 25 changed off screen";
		tui.requestRender();
		await terminal.waitForRender();

		// Shrink by 7 lines - few enough to take the incremental delete path
		// rather than a full redraw. The viewport now starts at line 23, so the
		// line we skipped is visible and must show its new text.
		content.lines = content.lines.slice(0, 33);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("line 25 changed off screen")),
			`skipped line must be repainted once visible, got: ${JSON.stringify(viewport)}`,
		);

		tui.stop();
	});
});
