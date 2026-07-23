# Keep working during a turn: queue and side questions

English | [简体中文](../../zh-CN/tutorials/work-while-running.md)

A creative turn may contain several provider requests and tool calls. You do not have to wait for the whole turn to finish before adding a requirement, or interrupt the main task just to ask one background question. This tutorial uses the input queue and `/btw` in practice.

## Add a requirement during a running turn

Start a task that reads source material and develops a plan. While the status bar shows that the Agent Loop is running, type another message:

> Do not reveal the character's real motive through their stated public goal.

Press Enter. The message appears in the FIFO above the composer. Vesicle lets the current tool round finish, then adds the message to the main conversation before the next provider request. If the main loop finishes first, the queued message is processed immediately as the next input.

Queue one more message, then press Up while the composer is empty. The latest queued input returns to the composer so you can edit and resubmit it. The queue is processed in submission order; actions that switch or reset the session clear the current queue.

If a new instruction must replace the direction being executed right now, press Esc. Vesicle interrupts the current provider request or tool operation, then prioritizes the next queued input. Do not use Esc as an ordinary “make this urgent” control: interruption may leave the current turn incomplete.

## Ask something beside the main turn

While the main turn is still running, enter:

```text
/btw Which constraints have already been fixed in the current plan?
```

The answer streams into a temporary overlay while the main turn continues underneath. The question reads the main conversation's latest complete provider-valid context boundary; it cannot observe a half-written tool round and never enters the main conversation to steer later writing.

In the overlay you can use:

- Up / Down: scroll the current answer.
- Left / Right: move between side exchanges from this process.
- `c`: copy the current answer as Markdown.
- `x`: clear this session's side exchanges and close.
- Esc: close the overlay; while an answer is loading, this cancels only the side request, not the main turn.

After closing it, enter `/btw` without a question to reopen the latest answer.

## Choose the right path

- A **queued message** enters the main conversation. Use it to add constraints, correct direction, or schedule the next step.
- **`/btw`** stays outside the main conversation. Use it for a quick background check, constraint recap, or term explanation.
- `/btw` declares no tools, so it cannot read a new file, modify an artifact, or run a command for you. Side exchanges live only in the current process and disappear after restart.

Slash commands do not all use the same busy-turn scheduling: host-only queries may run immediately, artifact reads wait for the current tool round, and configuration, picker, or session commands wait for the Agent Loop. See the [command cheatsheet](../reference/commands.md) when you need the exact behavior.

## Checklist

- [ ] You queued a follow-up requirement during a running turn.
- [ ] You used Up to retrieve and edit the latest queued input.
- [ ] You asked with `/btw` and closed the answer without interrupting the main turn.
- [ ] You can distinguish a queued message that enters the main conversation from a temporary side question.

Next, continue with [First character card](./first-character-card.md).
