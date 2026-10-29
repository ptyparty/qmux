import { describe, expect, test } from "bun:test";
import { Transcript, type StreamMessage } from "./transcript.ts";

function feed(transcript: Transcript, ...messages: StreamMessage[]): Transcript {
  for (const message of messages) transcript.apply(message);
  return transcript;
}

const init: StreamMessage = { type: "system", subtype: "init", session_id: "d9d5e825-f1d6-4857", model: "claude-haiku-5-5" };
const event = (event: StreamMessage["event"]): StreamMessage => ({ type: "stream_event", event });

describe("Transcript", () => {
  test("init records the session", () => {
    const transcript = feed(new Transcript(), init);
    expect([transcript.state, transcript.sessionId, transcript.model]).toEqual(["idle", "d9d5e825-f1d6-4857", "claude-haiku-5-5"]);
  });

  test("text streams into one entry and the full message finishes it", () => {
    const transcript = feed(new Transcript(), init);
    transcript.addPrompt("say hi");
    feed(
      transcript,
      event({ type: "content_block_start", content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }),
      event({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
    );
    expect(transcript.entries).toEqual([
      { kind: "user", text: "say hi" },
      { kind: "text", text: "Hello", streaming: true },
    ]);
    expect(transcript.state).toBe("working");
    feed(transcript, { type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } });
    expect(transcript.entries[1]).toEqual({ kind: "text", text: "Hello!", streaming: false });
  });

  test("tool calls become one line each and take their result's outcome", () => {
    const transcript = feed(
      new Transcript(),
      init,
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test\nnpm run lint", description: "Run tests" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } },
    );
    expect(transcript.entries).toEqual([
      { kind: "tool", id: "t1", name: "Bash", summary: "npm test …", status: "ok" },
      { kind: "tool", id: "t2", name: "Read", summary: "/a.ts", status: "error" },
    ]);
  });

  test("subagent messages stay out of the transcript", () => {
    const transcript = feed(new Transcript(), init, { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "inner" }] } });
    expect(transcript.entries).toEqual([]);
  });

  test("an interrupt shows as a notice and the result makes it ready with the cost", () => {
    const transcript = feed(
      new Transcript(),
      init,
      { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
      { type: "result", subtype: "success", total_cost_usd: 0.0123 },
    );
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Request interrupted by user for tool use", tone: "warning" }]);
    expect([transcript.state, transcript.cost]).toEqual(["idle", 0.0123]);
  });

  test("an error result is shown, unless it follows an interrupt", () => {
    const transcript = feed(new Transcript(), init, { type: "result", subtype: "error_during_execution", is_error: true });
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Claude stopped: error_during_execution", tone: "error" }]);
    transcript.interrupt();
    feed(transcript, { type: "result", subtype: "error_during_execution", is_error: true });
    expect(transcript.entries).toHaveLength(1);
  });

  test("a message typed after Claude exits isn't sent", () => {
    const transcript = feed(new Transcript(), init);
    transcript.ended("Claude exited with code 1");
    expect(transcript.addPrompt("hello?")).toBe(false);
    expect(transcript.state).toBe("ended");
    expect(transcript.entries.at(-1)).toEqual({ kind: "notice", text: "Claude has exited, so this message wasn't sent", tone: "error" });
  });

  test("a permission answered after an interrupt leaves Claude idle", () => {
    const transcript = feed(new Transcript(), init);
    transcript.permissionAsked("Bash");
    transcript.interrupt();
    feed(transcript, { type: "result", subtype: "error_during_execution", is_error: true });
    transcript.permissionAnswered("Bash", "denied");
    expect(transcript.state).toBe("idle");
  });

  test("changes name only the entries that need drawing again", () => {
    const transcript = feed(new Transcript(), init);
    transcript.addPrompt("hi");
    feed(transcript, event({ type: "content_block_start", content_block: { type: "text", text: "" } }));
    expect(transcript.takeChanges()).toEqual(transcript.entries);
    feed(transcript, event({ type: "content_block_delta", delta: { type: "text_delta", text: "yo" } }));
    expect(transcript.takeChanges()).toEqual([transcript.entries[1]!]);
    expect(transcript.takeChanges()).toEqual([]);
  });

  test("permission waits are shown and then say how they were answered", () => {
    const transcript = feed(new Transcript(), init);
    transcript.permissionAsked("Write");
    expect(transcript.state).toBe("waiting");
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Waiting for you: allow Write?", tone: "warning" }]);
    transcript.permissionAnswered("Write", "denied");
    expect(transcript.state).toBe("working");
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Denied Write", tone: "warning" }]);
  });

  test("a dismissed permission says so", () => {
    const transcript = feed(new Transcript(), init);
    transcript.permissionAsked("Bash");
    transcript.permissionAnswered("Bash", "dismissed");
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Dismissed Bash", tone: "warning" }]);
  });

  test("a prompt queued during a turn keeps Claude working until it is taken up and answered", () => {
    const transcript = feed(new Transcript(), init);
    transcript.addPrompt("first", "u1");
    feed(transcript, { type: "user", isReplay: true, uuid: "u1", message: { content: "first" } });
    transcript.addPrompt("second", "u2");
    feed(transcript, { type: "result", subtype: "success" });
    expect(transcript.state).toBe("working");
    feed(transcript, { type: "user", isReplay: true, uuid: "u2", message: { content: "second" } }, { type: "result", subtype: "success" });
    expect(transcript.state).toBe("idle");
    expect(transcript.entries).toEqual([
      { kind: "user", text: "first" },
      { kind: "user", text: "second" },
    ]);
  });

  test("an interrupt drops prompts still queued", () => {
    const transcript = feed(new Transcript(), init);
    transcript.addPrompt("first", "u1");
    transcript.interrupt();
    feed(transcript, { type: "result", subtype: "error_during_execution", is_error: true });
    expect(transcript.state).toBe("idle");
  });

  test("skill text loaded into the conversation isn't shown, other user text is a quiet notice", () => {
    const transcript = feed(
      new Transcript(),
      init,
      { type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "Base directory for this skill: /skills/espalier\n\n# espalier" }] } },
      { type: "user", message: { content: [{ type: "text", text: "Stop hook feedback:\nmore detail" }] } },
    );
    expect(transcript.entries).toEqual([{ kind: "notice", text: "Stop hook feedback: …", tone: "info" }]);
  });

  test("replaying a resumed conversation shows its prompts, replies and tools", () => {
    const transcript = new Transcript();
    transcript.replay([
      { type: "user", message: { content: [{ type: "text", text: "fix it" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "make" } }] } },
    ]);
    expect(transcript.entries).toEqual([
      { kind: "user", text: "fix it" },
      { kind: "tool", id: "t1", name: "Read", summary: "/a.ts", status: "ok" },
      { kind: "text", text: "Fixed.", streaming: false },
      { kind: "tool", id: "t2", name: "Bash", summary: "make", status: "error" },
      { kind: "notice", text: "Resumed · earlier messages above", tone: "info" },
    ]);
    expect(transcript.state).toBe("idle");
  });
});
