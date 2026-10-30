"use client";

import { useEffect, useState, type FormEvent } from "react";
import { READER_LIMITS as R } from "@/lib/config";
import { isoDate } from "@/lib/news/format";

type Comment = { id: string; name: string; body: string; createdAt: string };
type Data = { likes: number; liked: boolean; comments: Comment[]; signIn: boolean; me: { name: string } | null };

const btn = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-[15px] font-semibold disabled:opacity-60";
const primary = `${btn} bg-deep-sage text-white hover:bg-deep-sage-dark`;
const field = "w-full rounded-lg border border-input bg-paper px-3 text-[15px] text-ink placeholder:text-secondary";

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && data.ok !== false, status: res.status, data };
}
const message = (d: Record<string, unknown>, fallback: string) => (typeof d.error === "string" ? d.error : fallback);

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.700 3.700 4.500 7 4.500c2 0 3.400 1 5 3 1.600-2 3-3 5-3 3.300 0 5.400 3.200 4.200 6.600-1.700 4.800-9.200 9.400-9.200 9.400Z" />
    </svg>
  );
}

/** Asks for a company email, sends a code to it, and signs the reader in with the code. */
function SignIn({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await post("/api/reader/code", { email });
      if (r.ok) setStep("code");
      else setError(message(r.data, "The code could not be sent."));
    } catch {
      setError("The code could not be sent. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await post("/api/reader/verify", { email, code });
      if (r.ok) onDone();
      else setError(message(r.data, "The code could not be checked."));
    } catch {
      setError("The code could not be checked. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={step === "email" ? send : verify} className="flex flex-col gap-3 rounded-lg border border-line bg-feed p-4 font-sans">
      <p className="text-[15px] font-medium text-ink">Sign in with your company email to like or comment.</p>
      {step === "email" ? (
        <>
          <label htmlFor="reader-email" className="text-[14px] font-medium text-ink">Company email</label>
          <input id="reader-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${field} h-11`} />
          <p className="text-[13px] text-secondary">We email you a {R.CODE_DIGITS}-digit code. Your address is not stored or shown: only a one-way code made from it.</p>
          <button type="submit" disabled={pending} className={primary}>{pending ? "Sending…" : "Send me a code"}</button>
        </>
      ) : (
        <>
          <label htmlFor="reader-code" className="text-[14px] font-medium text-ink">Code from the email we sent</label>
          <input id="reader-code" inputMode="numeric" pattern="[0-9 ]*" autoComplete="one-time-code" required maxLength={R.CODE_DIGITS + 2} value={code} onChange={(e) => setCode(e.target.value)} className={`${field} h-11 font-mono tracking-[0.3em]`} />
          <p className="text-[13px] text-secondary">It works for {R.CODE_TTL_MINUTES} minutes.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={primary}>{pending ? "Checking…" : "Sign in"}</button>
            <button type="button" onClick={() => { setStep("email"); setCode(""); setError(null); }} className={`${btn} border border-input text-ink hover:bg-mint`}>Use another address</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-[14px] font-medium text-red-800">{error}</p>}
    </form>
  );
}

/** The like button and the comments under a Write story. Loaded after the story, never part of the cached page. */
export function Engagement({ slug }: { slug: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [signing, setSigning] = useState(false);
  const [likeError, setLikeError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [liking, setLiking] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  // One instance per story (the parent gives it a key), so it starts in the loading state. `tick` asks for a fresh copy.
  useEffect(() => {
    let live = true;
    fetch(`/api/story/${encodeURIComponent(slug)}/engagement`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<Data>) : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (!live) return;
        setData(body);
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [slug, tick]);
  async function like() {
    if (!data || liking) return;
    if (!data.me) return setSigning(true);
    setLikeError(null);
    setLiking(true);
    const before = data;
    // Optimistic: the heart changes at once and is put back if the server says no.
    setData({ ...data, liked: !data.liked, likes: Math.max(0, data.likes + (data.liked ? -1 : 1)) });
    try {
      const r = await post(`/api/story/${encodeURIComponent(slug)}/like`);
      if (r.ok && typeof r.data.likes === "number" && typeof r.data.liked === "boolean") setData((d) => (d ? { ...d, likes: r.data.likes as number, liked: r.data.liked as boolean } : d));
      else {
        setData(before);
        if (r.status === 401) setSigning(true);
        setLikeError(message(r.data, "Your like could not be saved."));
      }
    } catch {
      setData(before);
      setLikeError("Your like could not be saved. Check your connection.");
    } finally {
      setLiking(false);
    }
  }

  async function comment(e: FormEvent) {
    e.preventDefault();
    if (!data?.me) return setSigning(true);
    setPosting(true);
    setCommentError(null);
    try {
      const r = await post(`/api/story/${encodeURIComponent(slug)}/comments`, { body: text });
      if (r.ok && r.data.comment && typeof r.data.comment === "object") {
        const created = r.data.comment as Comment;
        setData((d) => (d ? { ...d, comments: [created, ...d.comments] } : d));
        setText("");
      } else {
        if (r.status === 401) setSigning(true);
        setCommentError(message(r.data, "Your comment could not be saved."));
      }
    } catch {
      setCommentError("Your comment could not be saved. Check your connection.");
    } finally {
      setPosting(false);
    }
  }

  async function signOut() {
    await post("/api/reader/signout").catch(() => null);
    setSigning(false);
    reload();
  }

  return (
    <section aria-label="Likes and comments" className="mx-auto mt-12 w-full max-w-[680px] border-t border-line pt-8 font-sans text-body">
      {state === "loading" && <p role="status" className="text-[14px] text-secondary">Loading likes and comments…</p>}
      {state === "error" && (
        <p role="alert" className="text-[14px] text-secondary">
          Likes and comments could not be loaded. <button type="button" onClick={() => { setState("loading"); reload(); }} className="font-medium underline">Try again</button>
        </p>
      )}

      {state === "ready" && data && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void like()}
              aria-pressed={data.liked}
              aria-label={data.liked ? `Unlike this story (${data.likes} likes)` : `Like this story (${data.likes} likes)`}
              disabled={liking}
              className={`${btn} gap-2 border ${data.liked ? "border-deep-sage bg-mint text-ink" : "border-input bg-paper text-ink hover:bg-mint"}`}
            >
              <Heart filled={data.liked} />
              <span className="tabular-nums">{data.likes}</span>
            </button>
            {data.me && (
              <p className="text-[13px] text-secondary">
                Signed in as {data.me.name}. <button type="button" onClick={() => void signOut()} className="underline">Sign out</button>
              </p>
            )}
            {likeError && <p role="alert" className="text-[13px] font-medium text-red-800">{likeError}</p>}
          </div>

          {!data.me && !data.signIn && <p className="rounded-lg bg-feed px-4 py-3 text-[14px] text-secondary">Likes and comments are not switched on for this site yet.</p>}
          {!data.me && data.signIn && (signing ? <SignIn onDone={() => { setSigning(false); reload(); }} /> : <button type="button" onClick={() => setSigning(true)} className={`${btn} self-start border border-input text-ink hover:bg-mint`}>Sign in to like or comment</button>)}

          <div className="flex flex-col gap-3">
            <h2 className="font-headline text-[22px] font-bold text-ink">Comments ({data.comments.length})</h2>
            {data.me && (
              <form onSubmit={comment} className="flex flex-col gap-2">
                <label htmlFor="comment-body" className="text-[14px] font-medium text-ink">Add a comment</label>
                <textarea id="comment-body" rows={3} required minLength={R.COMMENT_MIN} maxLength={R.COMMENT_MAX} value={text} onChange={(e) => setText(e.target.value)} className={`${field} py-2.5 leading-relaxed`} />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="submit" disabled={posting || text.trim().length < R.COMMENT_MIN} className={primary}>{posting ? "Posting…" : "Post comment"}</button>
                  <span className="text-[13px] text-secondary">{text.length} of {R.COMMENT_MAX}. Your first name is shown with it.</span>
                </div>
                {commentError && <p role="alert" className="text-[14px] font-medium text-red-800">{commentError}</p>}
              </form>
            )}
            {data.comments.length === 0 ? (
              <p className="text-[14px] text-secondary">No comments yet.{data.me ? " Be the first." : ""}</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {data.comments.map((c) => (
                  <li key={c.id} className="rounded-lg bg-feed px-4 py-3">
                    <p className="flex flex-wrap items-baseline gap-2 text-[14px]">
                      <span className="font-semibold text-ink">{c.name}</span>
                      <time dateTime={c.createdAt} className="font-mono text-[11px] text-meta">{isoDate(c.createdAt)}</time>
                    </p>
                    <p className="mt-1 whitespace-pre-line break-words text-[15px] leading-relaxed">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
