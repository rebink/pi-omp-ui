import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

const THEME = "omp-titanium";
const PATCH = Symbol.for("pi.omp-ui.tool-render");
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type CardStatus = "pending" | "running" | "success" | "warning" | "error";
type ThemeBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type ToolRuntime = {
  toolName: string;
  executionStarted: boolean;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
  callRendererComponent?: Component;
  imageComponents?: unknown[];
  getRenderShell?: () => "default" | "self";
};
type ToolRender = (width: number) => readonly string[];
type ToolMouse = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type ToolPatch = {
  theme?: Theme;
  originalRender: ToolRender;
  patchedRender: ToolRender;
  originalMouse?: ToolMouse;
  patchedMouse?: ToolMouse;
};
type ToolPrototype = {
  render: ToolRender;
  handleMouse?: ToolMouse;
  [PATCH]?: ToolPatch;
};

export type OmpTreeState = "complete" | "active" | "pending" | "blocked";
export type OmpTreeNode = {
  label: string;
  detail?: string;
  state?: OmpTreeState;
  children?: OmpTreeNode[];
  expanded?: boolean;
};


function statusVisual(status: CardStatus): { icon: string; label: string; color: ThemeColor; border: ThemeColor; bg: ThemeBg } {
  switch (status) {
    case "success": return { icon: "✔", label: "done", color: "success", border: "dim", bg: "toolSuccessBg" };
    case "warning": return { icon: "⚠", label: "warning", color: "warning", border: "warning", bg: "toolPendingBg" };
    case "error": return { icon: "✘", label: "failed", color: "error", border: "error", bg: "toolErrorBg" };
    case "running": return {
      icon: SPINNER[Math.floor(Date.now() / 80) % SPINNER.length] ?? "⟳",
      label: "running",
      color: "accent",
      border: "accent",
      bg: "toolPendingBg",
    };
    default: return { icon: "⏳", label: "pending", color: "accent", border: "accent", bg: "toolPendingBg" };
  }
}

function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function isBlank(line: string): boolean {
  return stripVTControlCharacters(line).trim().length === 0;
}

function warningFrom(details: unknown): boolean {
  return (details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated === true;
}

function toolStatus(tool: ToolRuntime): CardStatus {
  if (tool.result?.isError) return "error";
  if (!tool.executionStarted) return "pending";
  if (tool.isPartial || !tool.result) return "running";
  return warningFrom(tool.result.details) ? "warning" : "success";
}

function frameLines(
  theme: Theme,
  width: number,
  title: string,
  status: CardStatus,
  callLines: readonly string[],
  resultLines: readonly string[],
  contentAlreadyPadded = false,
): string[] {
  if (width <= 0) return [];
  if (width < 10) return [theme.fg("borderMuted", "─".repeat(width))];

  const visual = statusVisual(status);
  const border = (text: string) => theme.fg(visual.border, text);
  const bgAnsi = theme.getBgAnsi(visual.bg);
  const background = (text: string) => {
    const stable = text
      .replace(/\x1b\[(?:0)?m/g, (reset) => `${reset}${bgAnsi}`)
      .replace(/\x1b\[49m/g, (reset) => `${reset}${bgAnsi}`);
    return `${bgAnsi}${stable}\x1b[49m`;
  };
  const bar = (left: string, label: string, right: string) => {
    const prefix = `${left}───`;
    const rawLabel = label ? ` ${label} ` : "";
    const clipped = truncateToWidth(rawLabel, Math.max(0, width - visibleWidth(prefix) - visibleWidth(right)), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(clipped) - visibleWidth(right)));
    return background(`${border(prefix)}${clipped}${border(fill + right)}`);
  };
  const statusText = theme.fg(visual.color, `${visual.icon} ${visual.label}`);
  const header = `${statusText}${theme.fg("dim", " · ")}${theme.fg("toolTitle", theme.bold(title))}`;
  const contentWidth = contentAlreadyPadded ? width - 2 : width - 4;
  const lines = [bar("╭", header, "╮")];
  const addContent = (content: string) => {
    const wrapped = wrapTextWithAnsi(content, contentWidth);
    for (const line of wrapped.length > 0 ? wrapped : [""]) {
      const body = contentAlreadyPadded ? padAnsi(line, contentWidth) : ` ${padAnsi(line, contentWidth)} `;
      lines.push(background(`${border("│")}${body}${border("│")}`));
    }
  };

  if (callLines.length === 0 && resultLines.length === 0) addContent("");
  for (const line of callLines) addContent(line);
  if (resultLines.length > 0) {
    lines.push(bar("├", theme.fg("toolTitle", theme.bold("output")), "┤"));
    for (const line of resultLines) addContent(line);
  }
  lines.push(bar("╰", "", "╯"));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

function frameExistingTool(
  theme: Theme,
  width: number,
  title: string,
  status: CardStatus,
  raw: readonly string[],
  outputDivider: number | undefined,
  layout: "default" | "self" = "default",
): string[] {
  if (width < 10 || raw.length < (layout === "default" ? 4 : 2)) return [...raw];
  const visual = statusVisual(status);
  const border = (text: string) => theme.fg(visual.border, text);
  const bgAnsi = theme.getBgAnsi(visual.bg);
  const background = (text: string) => {
    const stable = text
      .replace(/\x1b\[(?:0)?m/g, (reset) => `${reset}${bgAnsi}`)
      .replace(/\x1b\[49m/g, (reset) => `${reset}${bgAnsi}`);
    return `${bgAnsi}${stable}\x1b[49m`;
  };
  const bar = (left: string, label: string, right: string) => {
    const prefix = `${left}───`;
    const rawLabel = label ? ` ${label} ` : "";
    const clipped = truncateToWidth(rawLabel, Math.max(0, width - visibleWidth(prefix) - visibleWidth(right)), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(clipped) - visibleWidth(right)));
    return background(`${border(prefix)}${clipped}${border(fill + right)}`);
  };
  const header = `${theme.fg(visual.color, `${visual.icon} ${visual.label}`)}${theme.fg("dim", " · ")}${theme.fg("toolTitle", theme.bold(title))}`;
  const body = layout === "default" ? [...raw.slice(2, -1)] : [...raw.slice(1)];
  const divider = outputDivider !== undefined && isBlank(body[outputDivider] ?? "") ? outputDivider : -1;
  if (divider >= 0) body[divider] = bar("├", theme.fg("toolTitle", theme.bold("output")), "┤");
  const framedBody = body.map((line, index) => index === divider
    ? line
    : background(`${border("│")}${padAnsi(line, width - 2)}${border("│")}`));
  const card = [bar("╭", header, "╮"), ...framedBody, bar("╰", "", "╯")];
  return layout === "default" ? [raw[0] ?? "", ...card] : card;
}

// Pi 0.85 has no renderer-only hook for built-ins. Decorating the TUI component
// keeps definitions, schemas, execution, result rendering, row count, and mouse geometry intact.
function installToolPresentation(theme: Theme): void {
  const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
  const existing = prototype[PATCH];
  if (existing) {
    existing.theme = theme;
    return;
  }
  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  const patch = {} as ToolPatch;
  const patchedRender: ToolRender = function renderOmpTool(this: ToolExecutionComponent, width: number): readonly string[] {
    const runtime = this as unknown as ToolRuntime;
    const shell = runtime.getRenderShell?.() ?? "default";
    if (!patch.theme || (shell === "self" && runtime.toolName !== "edit") || (runtime.imageComponents?.length ?? 0) > 0) {
      return originalRender.call(this, width);
    }
    const raw = originalRender.call(this, Math.max(1, width - 2));
    if (raw.length === 0) return raw;
    const outputDivider = shell === "default" && runtime.result && runtime.callRendererComponent
      ? runtime.callRendererComponent.render(Math.max(1, width - 4)).length
      : undefined;
    return frameExistingTool(patch.theme, width, runtime.toolName, toolStatus(runtime), raw, outputDivider, shell);
  };
  const patchedMouse: ToolMouse | undefined = originalMouse && function handleOmpToolMouse(this: ToolExecutionComponent, event: TuiMouseEvent) {
    const runtime = this as unknown as ToolRuntime;
    const shell = runtime.getRenderShell?.() ?? "default";
    if (!patch.theme || (shell === "self" && runtime.toolName !== "edit") || (runtime.imageComponents?.length ?? 0) > 0) {
      return originalMouse.call(this, event);
    }
    if (event.x <= 0 || event.x >= event.width - 1) return { handled: true };
    return originalMouse.call(this, { ...event, x: event.x - 1, width: Math.max(1, event.width - 2) });
  };
  Object.assign(patch, { theme, originalRender, patchedRender, originalMouse, patchedMouse });
  prototype.render = patchedRender;
  if (patchedMouse) prototype.handleMouse = patchedMouse;
  prototype[PATCH] = patch;
}

function restoreToolPresentation(): void {
  const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
  const patch = prototype[PATCH];
  if (!patch) return;
  patch.theme = undefined;
  if (prototype.render !== patch.patchedRender) return;
  prototype.render = patch.originalRender;
  if (patch.originalMouse && patch.patchedMouse && prototype.handleMouse === patch.patchedMouse) {
    prototype.handleMouse = patch.originalMouse;
  }
  delete prototype[PATCH];
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function usageTotals(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as AssistantMessage).usage;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
  }
  return totals;
}

function compactPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + sep) ? `~${sep}${path.slice(home.length + 1)}` : path;
}

function cleanStatus(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function fitSides(left: string, right: string, width: number): string {
  if (visibleWidth(left) >= width) return truncateToWidth(left, width, "…");
  const fittedRight = truncateToWidth(right, Math.max(0, width - visibleWidth(left) - 2), "");
  return left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(fittedRight))) + fittedRight;
}

function applyUi(ctx: ExtensionContext, getTotals: () => UsageTotals): void {
  if (ctx.mode !== "tui") return;
  const switched = ctx.ui.setTheme(THEME);
  if (!switched.success) ctx.ui.notify(switched.error ?? `Theme ${THEME} is unavailable`, "warning");
  installToolPresentation(ctx.ui.getTheme(THEME) ?? ctx.ui.theme);
  ctx.ui.setWorkingIndicator({ frames: SPINNER.map((frame) => ctx.ui.theme.fg("accent", frame)), intervalMs: 80 });
  ctx.ui.setEditorComponent((tui, theme, keybindings) =>
    new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true, paddingX: 1 }),
  );
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const totals = getTotals();
        const context = ctx.getContextUsage();
        const branch = footerData.getGitBranch();
        const session = ctx.sessionManager.getSessionName();
        const location = theme.fg("dim", compactPath(ctx.cwd));
        const branchText = branch ? ` ${theme.fg("success", branch)}` : "";
        const sessionText = session ? theme.fg("customMessageLabel", ` · ${session}`) : "";
        const pathLine = truncateToWidth(`${location}${branchText}${sessionText}`, width, "…");
        const stats = [
          totals.input ? `↑${formatCount(totals.input)}` : "",
          totals.output ? `↓${formatCount(totals.output)}` : "",
          totals.cacheRead ? `R${formatCount(totals.cacheRead)}` : "",
          totals.cacheWrite ? `W${formatCount(totals.cacheWrite)}` : "",
          `$${totals.cost.toFixed(3)}`,
        ].filter(Boolean).join(" ");
        const contextText = context?.percent == null
          ? `?/${formatCount(context?.contextWindow ?? ctx.model?.contextWindow ?? 0)}`
          : `${context.percent.toFixed(1)}%/${formatCount(context.contextWindow)}`;
        const contextColor: ThemeColor = (context?.percent ?? 0) > 90 ? "error" : (context?.percent ?? 0) > 70 ? "warning" : "muted";
        const left = theme.fg("dim", stats) + theme.fg("dim", " · ") + theme.fg(contextColor, contextText);
        const model = theme.fg("accent", ctx.model?.id ?? "no-model");
        const thinking = ctx.model?.reasoning ? theme.fg("customMessageLabel", ` · ${ctx.thinkingLevel}`) : "";
        const lines = [pathLine, fitSides(left, `${model}${thinking}`, width)];
        const statuses = [...footerData.getExtensionStatuses().entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => cleanStatus(text));
        if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" · "), width, "…"));
        return lines;
      },
    };
  });
}

export class OmpTreeList implements Component {
  constructor(private readonly nodes: OmpTreeNode[], private readonly theme: Theme) {}
  render(width: number): string[] {
    const lines: string[] = [];
    const visit = (nodes: OmpTreeNode[], ancestors: boolean[]) => {
      nodes.forEach((node, index) => {
        const last = index === nodes.length - 1;
        const prefix = ancestors.map((continues) => continues ? "│  " : "   ").join("") + (last ? "└─ " : "├─ ");
        const state = node.state ?? "pending";
        const marker = state === "complete" ? "✔" : state === "active" ? "⟳" : state === "blocked" ? "⚠" : "○";
        const color: ThemeColor = state === "complete" ? "success" : state === "active" ? "accent" : state === "blocked" ? "warning" : "dim";
        const group = node.children?.length ? (node.expanded === false ? " ▸" : " ▾") : "";
        const label = state === "active" ? this.theme.bold(node.label) : node.label;
        const detail = node.detail ? this.theme.fg("muted", ` · ${node.detail}`) : "";
        const row = `${this.theme.fg("dim", prefix)}${this.theme.fg(color, marker)} ${this.theme.fg(state === "pending" ? "muted" : "text", label)}${this.theme.fg("dim", group)}${detail}`;
        lines.push(truncateToWidth(row, width, "…"));
        if (node.children?.length && node.expanded !== false) visit(node.children, [...ancestors, !last]);
      });
    };
    visit(this.nodes, []);
    return lines;
  }
  invalidate(): void {}
}

async function showPreview(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("OMP UI preview requires interactive TUI mode", "warning");
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const card: Component = {
      render: (width) => frameLines(theme, width, "bash", "success", [
        `${theme.fg("accent", "$ ")}${theme.bold("printf 'normal Pi, OMP presentation\\n'")}`,
      ], [theme.fg("toolOutput", "normal Pi, OMP presentation"), theme.fg("dim", "Took 0.1s")]),
      invalidate() {},
    };
    const tree = new OmpTreeList([
      { label: "Inspect current Pi", state: "complete" },
      { label: "Port presentation", state: "active", children: [
        { label: "Tool cards", state: "complete" },
        { label: "Footer and composer", state: "active" },
        { label: "Agent behavior", detail: "unchanged", state: "pending" },
      ] },
    ], theme);
    return {
      render(width: number): string[] { return [...card.render(width), "", ...tree.render(width), "", theme.fg("dim", "Press any key to close")]; },
      handleInput(): void { done(); },
      invalidate(): void {},
    };
  });
}

export default function ompUi(pi: ExtensionAPI): void {
  let totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  pi.on("session_start", (_event, ctx) => {
    totals = usageTotals(ctx);
    if (ctx.mode === "tui") applyUi(ctx, () => totals);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") totals = usageTotals(ctx);
  });
  pi.on("session_shutdown", () => restoreToolPresentation());
  pi.registerCommand("omp-ui", {
    description: "Show OMP presentation status or preview",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        ctx.ui.notify("OMP UI is on; engine is normal Pi", "info");
        return;
      }
      if (action === "preview") {
        await showPreview(ctx);
        return;
      }
      ctx.ui.notify("Usage: /omp-ui [status|preview]", "error");
    },
  });
}
