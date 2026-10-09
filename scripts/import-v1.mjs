// Copy the current board of a v1 (PHP) whiteboard into a v3 room.
//   node scripts/import-v1.mjs https://redroom.zombiedawn.net/dame/whiteboard https://your-app.vercel.app [room]
const [v1, v3, room = "chaos"] = process.argv.slice(2);
if (!v1 || !v3) { console.error("usage: node scripts/import-v1.mjs <v1-base-url> <v3-base-url> [room]"); process.exit(1); }
const g = await (await fetch(`${v1.replace(/\/$/, "")}/api.php?view=grid`)).json();
const pts = [];
g.cells.forEach((row, y) => row.forEach((c, x) => pts.push([x, y, c.toLowerCase() === "#000000" ? null : c])));
const r = await fetch(`${v3.replace(/\/$/, "")}/api/rooms/${room}/ops`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-wb-name": "v1-import", "x-wb-kind": "agent" },
  body: JSON.stringify({ ops: [{ op: "pixels", pts }], nonce: `v1-import-${Date.now()}` }),
});
console.log(r.status, await r.text());
