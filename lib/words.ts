// Pictionary word bank: category -> difficulty -> words. All concrete enough to
// draw on a small pixel board. Rooms pick categories + difficulty, may add
// their own words, and draw from a shuffled deck so nothing repeats until the
// deck is used up.

export type Difficulty = "easy" | "medium" | "hard";

const B: Record<string, Record<Difficulty, string>> = {
  animals: {
    easy: "cat dog fish bird snake frog turtle rabbit mouse horse cow pig sheep duck owl bee spider ant snail crab whale shark lion bear monkey elephant giraffe zebra chicken",
    medium: "octopus penguin butterfly ladybug dolphin kangaroo crocodile flamingo peacock hedgehog squirrel jellyfish seahorse parrot camel koala panda raccoon bat worm",
    hard: "chameleon platypus narwhal axolotl porcupine scorpion stingray walrus armadillo mosquito caterpillar sloth anteater pelican lobster",
  },
  food: {
    easy: "apple banana cherry grape lemon pear pizza cake cookie egg carrot bread cheese icecream donut corn",
    medium: "burger taco sushi hotdog popcorn pancake waffle cupcake pretzel watermelon pineapple strawberry broccoli mushroom avocado sandwich spaghetti croissant lollipop",
    hard: "lasagna burrito dumpling paella omelette milkshake gingerbread fondue kebab ramen smoothie",
  },
  objects: {
    easy: "key lock door window chair table bed lamp clock phone ball book pencil cup bottle spoon fork hat shoe sock",
    medium: "scissors hammer umbrella glasses camera guitar drum piano trumpet balloon kite candle magnet battery lightbulb backpack wallet toothbrush ladder anchor",
    hard: "microscope telescope hourglass compass typewriter chandelier stethoscope parachute metronome accordion boomerang",
  },
  places: {
    easy: "house castle tent igloo bridge farm school park beach",
    medium: "lighthouse pyramid windmill factory hospital library stadium airport museum skyscraper volcano island",
    hard: "observatory aquarium colosseum treehouse submarine base space station haunted house",
  },
  nature: {
    easy: "sun moon star cloud rain snow tree flower leaf rainbow mountain river",
    medium: "lightning tornado cactus mushroom waterfall volcano desert forest wave iceberg",
    hard: "eclipse aurora avalanche earthquake galaxy constellation tsunami coral reef",
  },
  fantasy: {
    easy: "ghost robot alien dragon unicorn crown sword shield",
    medium: "wizard witch vampire zombie pirate knight mermaid skeleton snowman ninja treasure",
    hard: "werewolf phoenix kraken centaur genie time machine portal magic potion",
  },
  transport: {
    easy: "car bus truck train plane boat bicycle",
    medium: "rocket helicopter tractor submarine motorcycle sailboat skateboard scooter",
    hard: "hot air balloon spaceship roller coaster ferris wheel bulldozer cable car",
  },
  people: {
    easy: "baby king queen clown",
    medium: "astronaut firefighter doctor chef farmer painter police diver",
    hard: "magician scientist lifeguard detective conductor juggler",
  },
  actions: {
    easy: "sleeping running jumping swimming eating",
    medium: "dancing singing fishing skiing surfing climbing painting crying laughing",
    hard: "juggling sneezing sleepwalking skydiving meditating snoring",
  },
  body: {
    easy: "eye hand foot nose ear mouth heart",
    medium: "tooth bone brain skeleton beard mustache",
    hard: "fingerprint footprint heartbeat",
  },
  sports: {
    easy: "football basketball tennis golf",
    medium: "trophy medal bowling boxing karate archery",
    hard: "scuba diving snowboard hockey goalie",
  },
  tech: {
    easy: "computer television phone",
    medium: "headphones keyboard laptop joystick satellite",
    hard: "virtual reality wifi bluetooth hologram drone",
  },
};

export const CATEGORIES = Object.keys(B);
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

// Multi-word entries in the strings above use a placeholder-free trick: known
// compounds are listed here so splitting on spaces keeps them together.
const COMPOUNDS = [
  "space station", "haunted house", "coral reef", "time machine", "magic potion", "hot air balloon",
  "roller coaster", "ferris wheel", "cable car", "scuba diving", "virtual reality", "submarine base",
];

function split(s: string): string[] {
  let rest = ` ${s} `;
  const out: string[] = [];
  for (const c of COMPOUNDS) {
    if (rest.includes(` ${c} `)) { out.push(c); rest = rest.replace(` ${c} `, " "); }
  }
  return out.concat(rest.trim().split(/\s+/).filter(Boolean));
}

const LISTS: Record<string, Record<Difficulty, string[]>> = Object.fromEntries(
  Object.entries(B).map(([cat, d]) => [cat, { easy: split(d.easy), medium: split(d.medium), hard: split(d.hard) }]),
);

export function bankWords(categories: string[] | undefined, difficulty: Difficulty | "mixed" | undefined): string[] {
  const cats = categories && categories.length ? categories.filter((c) => LISTS[c]) : CATEGORIES;
  const levels = !difficulty || difficulty === "mixed" ? DIFFICULTIES : [difficulty];
  const out = new Set<string>();
  for (const c of cats) for (const l of levels) for (const w of LISTS[c][l]) out.add(w);
  return [...out];
}

export const MAX_CUSTOM = 1000;

export function cleanWords(list: unknown): string[] {
  if (!Array.isArray(list) && typeof list !== "string") return [];
  const raw = Array.isArray(list) ? list.map(String) : String(list).split(/[\n,;]+/);
  const out = new Set<string>();
  for (const w of raw) {
    const t = w.toLowerCase().replace(/\s+/g, " ").trim();
    if (/^[a-z][a-z' -]{1,30}[a-z]$/.test(t)) out.add(t);
  }
  return [...out].slice(0, MAX_CUSTOM);
}

// Kept for older imports.
export const WORDS = bankWords(undefined, "mixed");
