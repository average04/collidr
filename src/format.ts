import type { HubEvent, Thread } from "./types.js";

const short = (id: string) => id.slice(-6);

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human-readable one-liner for an event, used by `collidr watch` and `show`. */
export function describeEvent(ev: HubEvent): string {
  const time = new Date(ev.created_at).toTimeString().slice(0, 8);
  const who = ev.actor_id ?? "collidr";
  const thread = `[${short(ev.thread_id)}]`;
  let what: string;
  switch (ev.type) {
    case "message_posted": {
      const m = ev.message!;
      const tag = m.kind === "verdict" ? `VERDICT ${m.verdict === "approve" ? "approve" : "request_changes"}` : m.kind;
      const to = m.recipients ? ` → ${m.recipients.join(", ")}` : "";
      const model = m.sender_model ? ` (${m.sender_model})` : "";
      what = `${who}${model} ${tag}${to}: ${oneLine(m.body)}`;
      break;
    }
    case "revision_submitted":
      what = `${who} submitted r${ev.revision!.number} (${ev.revision!.content_type}, ${ev.revision!.content_size} bytes, round ${ev.revision!.round})`;
      break;
    case "request_created":
      what = `review requested from ${ev.request!.assignee_id}`;
      break;
    case "request_completed":
      what = `${ev.request!.assignee_id} completed their review`;
      break;
    case "request_superseded":
      what = `review request for ${ev.request!.assignee_id} superseded by a newer revision`;
      break;
    case "request_cancelled":
      what = `review request for ${ev.request!.assignee_id} cancelled`;
      break;
    case "thread_closed": {
      const r = ev.resolution;
      what = r ? `thread ${r.outcome.toUpperCase()} by ${r.resolved_by ?? "round limit"}: ${oneLine(r.summary)}` : "thread closed";
      break;
    }
    default:
      what = ev.type;
  }
  return `${String(ev.seq).padStart(5)} ${time} ${thread} ${what}`;
}

export function describeThread(t: Thread): string {
  return `${t.id}  ${t.status.padEnd(10)} ${t.type.padEnd(11)} round ${t.current_round}/${t.round_limit}  ${t.title}`;
}
