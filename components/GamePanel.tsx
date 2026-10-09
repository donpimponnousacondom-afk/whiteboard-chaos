"use client";
// Pictionary panel: round state, word choice for the drawer, a PRIVATE guess
// box for everyone else, guessed list and scores.
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./client";

export interface GameState {
  status: "idle" | "choosing" | "active" | "n/a" | string;
  round?: number; drawer?: string; hint?: string; endsAt?: number; startedAt?: number; chooseUntil?: number;
  word?: string; options?: string[]; youAreDrawer?: boolean; youGuessed?: boolean;
  guessed?: { name: string; pts: number }[]; scores?: { name: string; score: number }[];
  lastWord?: string | null; lastWinners?: string[]; roundSec?: number; maxGuessesPerRound?: number;
}

interface Props {
  roomId: string;
  game: GameState | null;
  myName: string;
  now: number;
  refresh: () => void;
  flash: (t: string, tone?: "info" | "bad") => void;
  feedback: { text: string; tone: "good" | "close" | "bad" } | null;
  setFeedback: (f: { text: string; tone: "good" | "close" | "bad" } | null) => void;
}

export default function GamePanel({ roomId, game, myName, now, refresh, flash, feedback, setFeedback }: Props) {
  const [guess, setGuess] = useState("");
  const [left, setLeft] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const g = game;
  const iDraw = !!g && g.drawer === myName;

  useEffect(() => { setLeft(null); setGuess(""); }, [g?.round]);

  const action = async (a: "start" | "skip" | "pick", word?: string) => {
    try {
      const r = await api<{ word?: string; options?: string[] }>(`/api/rooms/${roomId}/game`, { body: { action: a, word } });
      if (r.word) flash(`Your word: ${r.word}. Draw it, no letters.`);
      refresh();
    } catch (e) { flash((e as Error).message, "bad"); }
  };

  const sendGuess = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = guess.trim();
    if (!text) return;
    try {
      const r = await api<{ results: { correct?: boolean; close?: boolean; message?: string; guessesLeft?: number | null }[] }>(`/api/rooms/${roomId}/ops`, { body: { ops: [{ op: "guess", text }] } });
      const res = r.results[0] ?? {};
      if (res.guessesLeft !== undefined) setLeft(res.guessesLeft ?? null);
      setFeedback({ text: res.correct ? res.message ?? "Correct!" : res.close ? `"${text}" is so close. Check the spelling.` : `"${text}" is not it.`, tone: res.correct ? "good" : res.close ? "close" : "bad" });
      setGuess("");
      if (res.correct) refresh();
      input.current?.focus();
    } catch (err) {
      const msg = err instanceof ApiError && err.retryMs ? `${err.message}` : (err as Error).message;
      setFeedback({ text: msg, tone: "bad" });
    }
  };

  const chooseLeft = g?.chooseUntil ? Math.max(0, Math.ceil((g.chooseUntil - now) / 1000)) : 0;
  const roundLeft = g?.endsAt ? Math.max(0, Math.ceil((g.endsAt - now) / 1000)) : 0;
  const total = g?.endsAt && g?.startedAt ? (g.endsAt - g.startedAt) / 1000 : g?.roundSec ?? 120;

  return (
    <div className="panel game">
      {g?.status === "choosing" ? (
        iDraw && g.options ? (
          <>
            <div className="game-row"><span>Pick a word to draw</span><span className="num big">{chooseLeft}s</span></div>
            <div className="options">{g.options.map((w, i) => (
              <button key={w} className="btn" onClick={() => action("pick", String(i + 1))}>{w}</button>
            ))}</div>
          </>
        ) : (
          <div className="game-row"><span>{g.drawer} is choosing a word</span><span className="num big">{chooseLeft}s</span></div>
        )
      ) : g?.status === "active" ? (
        <>
          <div className="game-row">
            <span>{iDraw ? "You are drawing" : `${g.drawer} is drawing`}</span>
            <span className={`num big ${roundLeft <= 10 ? "hurry" : ""}`}>{roundLeft}s</span>
          </div>
          <div className="timebar"><div style={{ width: `${Math.min(100, (roundLeft / Math.max(1, total)) * 100)}%` }} /></div>
          {g.word ? <p className="secret">{iDraw ? "Your word" : "You got it"}: <b>{g.word}</b></p> : <p className="hint num" aria-label="hint">{g.hint}</p>}
          {!iDraw && !g.youGuessed && (
            <form className="guess" onSubmit={sendGuess}>
              <input ref={input} value={guess} onChange={(e) => setGuess(e.target.value)} placeholder="Your guess (only you see it)" autoComplete="off" spellCheck={false} maxLength={60} />
              <button className="btn hot" type="submit">Guess</button>
            </form>
          )}
          {feedback && <p className={`feedback ${feedback.tone}`}>{feedback.text}{left !== null && !g.youGuessed ? ` ${left} guesses left.` : ""}</p>}
          {!!g.guessed?.length && (
            <p className="guessed">Got it: {g.guessed.map((x) => `${x.name} +${x.pts}`).join(", ")}</p>
          )}
          {(iDraw || roundLeft === 0) && <button className="btn ghost" onClick={() => action("skip")}>End round</button>}
        </>
      ) : (
        <>
          <p>{g?.lastWord ? `Last word: ${g.lastWord}. ${g.lastWinners?.length ? `Guessed by ${g.lastWinners.join(", ")}.` : "Nobody got it."}` : "Nobody is drawing yet."}</p>
          <button className="btn hot" onClick={() => action("start")}>Draw the next word</button>
        </>
      )}
      {!!g?.scores?.length && (
        <ol className="scores">{g.scores.map((s) => <li key={s.name}><span>{s.name}</span><span className="num">{s.score}</span></li>)}</ol>
      )}
    </div>
  );
}
