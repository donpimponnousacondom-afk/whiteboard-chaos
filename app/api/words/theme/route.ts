// GET /api/words/theme?q=pirates&max=40 -> drawable nouns related to a theme.
// Uses Datamuse (free, no key): "means like" + "triggered by" relations, keeps
// common nouns only. Results are cached for a day.
import { NextRequest } from "next/server";
import { HttpError, json, route } from "@/lib/http";
import { getStore } from "@/lib/store";
import { bankWords, cleanWords } from "@/lib/words";

export const dynamic = "force-dynamic";

interface DmWord { word: string; score?: number; tags?: string[] }

export const GET = route(async (req: NextRequest) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").toLowerCase().trim().slice(0, 40);
  const max = Math.max(5, Math.min(100, Number(req.nextUrl.searchParams.get("max") ?? 40)));
  if (!/^[a-z][a-z -]{1,39}$/.test(q)) throw new HttpError(400, "bad_theme", "q must be a word or two, letters only");
  const cacheKey = `wb:theme3:${q}`;
  const cached = await getStore().kvGet(cacheKey);
  let words: string[];
  if (cached) words = JSON.parse(cached);
  else {
    const base = "https://api.datamuse.com/words";
    const one = q.endsWith("ies") ? q.slice(0, -3) + "y" : /(s|x|ch|sh)es$/.test(q) ? q.slice(0, -2) : q.endsWith("s") && !q.endsWith("ss") ? q.slice(0, -1) : q;
    // "triggered by" gives the concrete things people associate with a theme
    // (pirate -> ship, treasure, parrot, sword); "means like" adds a few more.
    const sources: [string, number][] = [
      [`${base}?rel_trg=${encodeURIComponent(one)}&md=pf&max=150`, 3],
      [`${base}?ml=${encodeURIComponent(one)}&md=pf&max=150`, 1],
      [`${base}?topics=${encodeURIComponent(one)}&ml=${encodeURIComponent(one)}&md=pf&max=100`, 1],
    ];
    const lists = await Promise.all(sources.map(async ([u, weight]) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
        return { weight, list: r.ok ? ((await r.json()) as DmWord[]) : [] };
      } catch { return { weight, list: [] as DmWord[] }; }
    }));
    const bank = new Set(bankWords(undefined, "mixed"));
    const abstract = /(tion|sion|ness|ment|ity|ism|ance|ence|ship|hood|ing|ology)$/;
    const scored = new Map<string, number>();
    for (const { weight, list } of lists) list.forEach((w, rank) => {
      const tags = w.tags ?? [];
      const f = Number(tags.find((t) => t.startsWith("f:"))?.slice(2) ?? 0);
      // lowercase "n" = singular common noun; skip names, plurals ("N") and rare or ultra-common words
      if (!tags.includes("n") || tags.includes("prop") || f < 0.8 || f > 120) return;
      const word = w.word.toLowerCase();
      if (word === one || word === q || word.split(" ").length > 2 || word.length < 3 || word.length > 16 || abstract.test(word)) return;
      if (/[^su]s$/.test(word) && !/(ss|us|is)$/.test(word)) return; // plurals: the singular usually shows up too
      const score = weight * (150 - Math.min(rank, 149)) + (bank.has(word) ? 200 : 0);
      scored.set(word, (scored.get(word) ?? 0) + score);
    });
    words = cleanWords([...scored.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w));
    if (!words.length) throw new HttpError(404, "no_words", `no drawable words found for '${q}'. Try another theme`);
    await getStore().kvSet(cacheKey, JSON.stringify(words), 86400_000);
  }
  return json({ theme: q, words: words.slice(0, max), source: "datamuse.com" });
});
