import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api.ts";

interface Reply { title: string; sections: { heading?: string; bullets: string[] }[]; suggestions: string[]; source: string }
type Msg = { who: "me"; text: string } | { who: "si"; reply: Reply } | { who: "err"; text: string };

export interface WingmanContext { appId?: string; releaseId?: string; findingId?: string; subtitle: string; opening: string; nonce?: number }

function WingMark() {
  return (
    <svg viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="16" fill="#f0ecfd" stroke="#6b4fd8" strokeWidth="1.5" />
      <path d="M6 18c4-1 7-4 11-9 4 5 7 8 11 9-4 0-7 1.5-11 7-4-5.5-7-7-11-7z" fill="#6b4fd8" />
    </svg>
  );
}

export function Wingman({ ctx }: { ctx: WingmanContext }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const feed = useRef<HTMLDivElement>(null);
  const key = `${ctx.appId}|${ctx.releaseId}|${ctx.findingId}|${ctx.opening}|${ctx.nonce ?? 0}`;

  const gen = useRef(0); // bumps when the page context changes; answers for an older context are dropped

  const ask = async (prompt: string, extra?: Partial<WingmanContext>) => {
    if (!prompt.trim()) return;
    const mine = gen.current;
    setBusy(true);
    try {
      const reply = await api<Reply>("/wingman", { method: "POST", body: { prompt, appId: ctx.appId, releaseId: ctx.releaseId, findingId: extra && "findingId" in extra ? extra.findingId : ctx.findingId } });
      if (mine === gen.current) setMsgs((m) => [...m, { who: "si", reply }]);
    } catch (e) {
      if (mine === gen.current) setMsgs((m) => [...m, { who: "err", text: (e as Error).message }]);
    } finally { if (mine === gen.current) setBusy(false); }
  };

  // A fresh briefing whenever the page (or the finding asked about) changes.
  useEffect(() => { gen.current++; setMsgs([]); void ask(ctx.opening); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [msgs, busy]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setMsgs((m) => [...m, { who: "me", text: t }]);
    setText("");
    if (!busy) void ask(t, { findingId: undefined });
  };
  const last = [...msgs].reverse().find((m): m is Extract<Msg, { who: "si" }> => m.who === "si");

  return (
    <aside className="wing" aria-label="SI Wingman">
      <div className="hd">
        <WingMark />
        <div><b>Wingman<span className="si">SI</span></b><div className="small muted">{ctx.subtitle}</div></div>
        <span className="mode" title="Answers come from Release Forge data and fixed guidance; no language model is called.">Offline</span>
      </div>
      <div className="feed" ref={feed} aria-live="polite">
        {msgs.map((m, i) => m.who === "me"
          ? <div key={i} className="msg me">{m.text}</div>
          : m.who === "err" ? <div key={i} className="err">{m.text}</div>
          : <div key={i} className="msg">
              <h4>{m.reply.title}</h4>
              {m.reply.sections.map((s, j) => <div key={j}>{s.heading && <h5>{s.heading}</h5>}<ul>{s.bullets.map((b, k) => <li key={k}>{b}</li>)}</ul></div>)}
            </div>)}
        {busy && <div className="typing">Wingman is checking the data…</div>}
      </div>
      {last && <div className="sugg">{last.reply.suggestions.map((s) => <button key={s} type="button" onClick={() => { setMsgs((m) => [...m, { who: "me", text: s }]); void ask(s, { findingId: undefined }); }}>{s}</button>)}</div>}
      <form onSubmit={send}>
        <label className="sr" htmlFor="wing-q">Ask Wingman</label>
        <input id="wing-q" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Wingman…" maxLength={500} />
        <button type="submit" disabled={busy} aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12l16-8-6 16-2-6z" /></svg>
        </button>
      </form>
    </aside>
  );
}
