export type Mode = "free" | "place" | "guess" | "life";

export interface RoomMeta {
  id: string;
  title: string;
  theme: string;          // free text prompt / rules shown to humans and agents
  w: number;
  h: number;
  mode: Mode;
  bg: string;             // render color of empty cells
  cooldownMs: number;     // place mode: ms per pixel
  burst: number;          // rate limit bucket size (pixels)
  refillPerSec: number;   // rate limit refill (pixels/second)
  keyHash: string;        // sha256 of write key, "" = open room
  createdAt: number;
  createdBy: string;
  system?: boolean;       // built-in room (cannot be deleted without admin)
  ownerKeyHash?: string;  // sha256 of the owner key returned once at creation
  settings?: Partial<RoomSettings>;
}

export interface GameCfg {
  choices: 1 | 3 | 5;                 // words offered to the drawer
  roundSec: number;                   // round length
  categories: string[];               // [] = all built-in categories
  difficulty: "easy" | "medium" | "hard" | "mixed";
  custom: string[];                   // the room's own words
  customOnly: boolean;                // true = only the room's own words
}

export interface RoomSettings {
  chatSlowSec: { human: number; agent: number };   // min seconds between chat messages per name
  guessSlowSec: { human: number; agent: number };  // min seconds between guesses per name
  maxGuessesPerRound: number;                      // 0 = unlimited
  game: GameCfg;
}

export interface Actor {
  name: string;
  kind: "human" | "agent";
  ip: string;
}

// Persisted events carry a seq. Ephemeral events (cursor, presence) do not.
export interface WbEvent {
  seq?: number;
  t: number;
  kind: "draw" | "chat" | "game" | "meta" | "system" | "cursor" | "presence" | "snapshot" | "reconnect";
  actor?: string;
  actorKind?: "human" | "agent";
  [k: string]: unknown;
}

export interface Snapshot {
  board: string;
  seq: number;
  palette: string[];
}

export type CommitResult =
  | { status: "ok"; seq: number }
  | { status: "dup"; seq: number }
  | { status: "limited"; retryMs: number }
  | { status: "conflict"; seq: number };

export interface CommitReq {
  n: number;                       // cell count, used to init the board
  changes?: Map<number, string>;   // idx -> char
  full?: string;                   // complete replacement board
  event: WbEvent;                  // event body (seq gets added)
  nonce?: string;                  // replay protection
  cost: number;                    // pixels consumed from the actor bucket
  burst: number;
  refillPerSec: number;
  allowDebt: boolean;              // free mode lets big ops go negative
  bucket: string;                  // actor id for the bucket
  ipBucket?: string;               // client IP: second, larger bucket shared by every name on that IP
  expectSeq?: number;              // compare-and-set: only commit if the room is still at this seq
}
