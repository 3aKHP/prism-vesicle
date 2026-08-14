import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { loadSessionRecords } from "../core/session/store";
import { turnAnchorsFromSnapshot, type TurnAnchor } from "./turn-anchors";
import type { Message } from "./types";

// Turn-focus cursor domain controller (Alt+↑/↓): owns the anchor list, the
// focused-turn state, the debounced refresh from durable records, and the
// Alt+←/→ rejection guidance policy — keeping the composition root thin and
// matching the createXController convention of every other TUI domain here.

export type TurnFocusControllerOptions = {
  rootDir: string;
  sessionId: Accessor<string | undefined>;
  messages: Accessor<Message[]>;
  busy: Accessor<boolean>;
  setStatus: (status: string) => void;
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
};

export function createTurnFocusController(options: TurnFocusControllerOptions) {
  const [turnAnchors, setTurnAnchors] = createSignal<TurnAnchor[]>([]);
  const [focusedTurn, setFocusedTurn] = createSignal<string | null>(null);

  // Anchors are recomputed from the durable records after transcript changes
  // settle; the 150 ms debounce keeps streaming updates from re-reading the
  // session file per delta.
  createEffect(() => {
    options.sessionId();
    options.messages();
    options.busy();
    const timer = setTimeout(() => {
      const id = options.sessionId();
      if (!id) {
        setTurnAnchors([]);
        setFocusedTurn(null);
        return;
      }
      void loadSessionRecords(options.rootDir, id).then((records) => {
        const anchors = turnAnchorsFromSnapshot(records);
        setTurnAnchors(anchors);
        const focused = focusedTurn();
        if (focused && !anchors.some((anchor) => anchor.forkUuid === focused)) setFocusedTurn(null);
      }).catch(() => {});
    }, 150);
    onCleanup(() => clearTimeout(timer));
  });

  /**
   * Guidance for a rejected Alt+←/→: shortcut-first wording (the Host sidebar
   * truncates the status line to one narrow row), plus a transcript notice so
   * the message survives the sidebar being hidden at 80 columns; consecutive
   * identical notices are deduped against keystroke spam.
   */
  function rejectCandidateSwitch(): void {
    const fork = focusedTurn();
    const anchor = fork ? turnAnchors().find((entry) => entry.forkUuid === fork) : undefined;
    const guidance = anchor?.hasCandidates
      ? "Ctrl+B: open the candidate tree (no switchable candidates on this turn)"
      : anchor
        ? "Ctrl+R: regenerate this turn (no switchable candidates)"
        : "Ctrl+R: regenerate the last turn (no switchable candidates)";
    options.setStatus(guidance);
    options.setMessages((prev) => {
      const last = prev.at(-1);
      if (last?.role === "system" && last.kind === "candidate-guidance" && last.content === guidance) return prev;
      return [...prev, { role: "system", content: guidance, kind: "candidate-guidance" }];
    });
  }

  return { turnAnchors, focusedTurn, setFocusedTurn, rejectCandidateSwitch };
}
