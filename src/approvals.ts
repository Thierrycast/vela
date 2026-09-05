import { BrowserAction } from "./types";
import { SidecarInbound } from "./messages";

export type ApprovalDecision = "allow" | "deny" | "allow-session";
export type ApprovalOutcome = ApprovalDecision | "unattended";
export type ApprovalRequest = { id: string; summary: string; detail: string };

const TIMEOUT_MS = 120_000;
const RISKY_LABEL = /\b(comprar|compra|pagar|pagamento|assinar|assinatura|excluir|apagar|deletar|remover|confirmar|finalizar|transferir|enviar|checkout|buy|pay|purchase|subscribe|delete|remove|confirm|submit|transfer|order)\b/i;

let broadcast: ((message: SidecarInbound) => void) | null = null;
let hasListener = () => false;
const pending = new Map<string, { resolve: (decision: ApprovalDecision) => void; timer: number }>();
const sessionAllowed = new Set<string>();

export function configureApprovals(send: (message: SidecarInbound) => void, connected: () => boolean) {
  broadcast = send;
  hasListener = connected;
}

export function resolveApproval(id: string, decision: ApprovalDecision) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(decision);
}

export function cancelPendingApprovals() {
  for (const [id] of pending) resolveApproval(id, "deny");
}

export function clearSessionApprovals() { sessionAllowed.clear(); }

let takeoverResolve: (() => void) | null = null;
export function resumeTakeover() { takeoverResolve?.(); takeoverResolve = null; }

/** O modelo pede intervenção humana e o loop fica suspenso até "Retomar". */
export async function requestTakeover(reason: string, expected: string): Promise<boolean> {
  if (!broadcast || !hasListener()) return false;
  broadcast({ type: "chat:takeover", reason, expected });
  await new Promise<void>((resolve) => {
    takeoverResolve = resolve;
    setTimeout(() => { if (takeoverResolve === resolve) { takeoverResolve = null; resolve(); } }, 600_000);
  });
  broadcast({ type: "chat:takeover-closed" });
  return true;
}

/** Ações irreversíveis pedem confirmação mesmo em modo Auto. */
export function isRisky(action: BrowserAction, targetLabel: string) {
  if (action.type === "click" && RISKY_LABEL.test(targetLabel)) return true;
  if (action.type === "type" && action.submit && RISKY_LABEL.test(targetLabel)) return true;
  return false;
}

export function describeAction(action: BrowserAction, targetLabel: string) {
  switch (action.type) {
    case "navigate": return `Abrir ${action.url}`;
    case "click": return `Clicar em ${targetLabel || action.ref || action.selector || "um elemento"}`;
    case "type": return `Digitar “${action.text.slice(0, 40)}”${action.submit ? " e enviar" : ""} em ${targetLabel || "um campo"}`;
    case "keyPress": return `Pressionar ${action.key}`;
    default: return `Executar ${action.type}`;
  }
}

export function approvalKey(action: BrowserAction, origin: string) {
  return `${action.type}:${origin}`;
}

export async function requestApproval(key: string, summary: string, detail: string): Promise<ApprovalOutcome> {
  if (sessionAllowed.has(key)) return "allow";
  if (!broadcast || !hasListener()) return "unattended";

  const id = crypto.randomUUID();
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve("deny"); }, TIMEOUT_MS) as unknown as number;
    pending.set(id, { resolve, timer });
    broadcast?.({ type: "chat:approval", request: { id, summary, detail } });
  });
  broadcast?.({ type: "chat:approval-closed", id });
  if (decision === "allow-session") sessionAllowed.add(key);
  return decision;
}
