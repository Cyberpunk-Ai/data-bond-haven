/**
 * The emoji set behind the picker, the quick reactions and the recents row.
 *
 * Why this exists: the compose bar's smiley button used to append a hardcoded
 * " ✨" to whatever you had typed, so "we don't have a variety of emojis" was
 * literally true — one emoji, chosen by us, on a button that looked like a
 * picker. Message reactions had six, the call had five, and there was no way to
 * send anything else, even though `message_reactions.emoji` is plain text and
 * the database would have accepted any of them.
 *
 * Kept as data plus pure rules (no DOM, no React) so `tests/emojis.test.ts` can
 * pin the behaviour in node, like the other rule modules.
 */

/** [character, name, extra search keywords] */
type RawEmoji = [char: string, name: string, keywords?: string];

export interface EmojiEntry {
  char: string;
  name: string;
  /** Lower-cased haystack of everything this emoji should match. */
  haystack: string;
}

export interface EmojiCategory {
  id: string;
  label: string;
  /** Shown on the category tab; a glyph rather than an icon set to stay dependency-free. */
  icon: string;
  emojis: EmojiEntry[];
}

const RAW: Array<{ id: string; label: string; icon: string; items: RawEmoji[] }> = [
  {
    id: "smileys",
    label: "Smileys",
    icon: "😀",
    items: [
      ["😀", "grinning", "happy smile"],
      ["😃", "smiley", "happy smile"],
      ["😄", "smile", "happy laugh"],
      ["😁", "grinning smiley", "teeth happy"],
      ["😆", "laughing", "satisfied haha"],
      ["😅", "hot laughter", "relieved sweat"],
      ["🤣", "rolling on the floor", "rofl laughing hard"],
      ["😂", "face with tears of joy", "laugh cry"],
      ["🙂", "slightly smiling", "yes polite"],
      ["🙃", "upside down", "silly irony"],
      ["😉", "wink", "flirt joke"],
      ["😊", "blush", "proud warm"],
      ["😇", "innocent", "angel halo"],
      ["🥰", "love smile", "affection hearts"],
      ["😍", "heart eyes", "love adore"],
      ["🤩", "star struck", "wow amazed"],
      ["😘", "kiss", "blow kiss love"],
      ["😗", "kissing face", "peck"],
      ["😚", "kissing closed eyes", "blush kiss"],
      ["😙", "kissing smile", "wink kiss"],
      ["🥲", "smiling tear", "grateful sad happy"],
      ["😋", "savouring", "yummy delicious"],
      ["😛", "tongue", "playful raspberry"],
      ["😜", "winking tongue", "crazy silly"],
      ["🤪", "zany", "wild goofy"],
      ["😝", "squinting tongue", "gross out"],
      ["🤑", "money mouth", "rich cash"],
      ["🤗", "hug", "hands open"],
      ["🤭", "hand over mouth", "gig shy Oops"],
      ["🤫", "shh", "quiet secret"],
      ["🤔", "thinking", "hmm consider"],
      ["🫡", "salute", "yes sir respect aye"],
      ["🤐", "zipper mouth", "secret silent"],
      ["😐", "neutral", "unimpressed flat"],
      ["😑", "expressionless", "deadpan"],
      ["😶", "no mouth", "silent speechless"],
      ["😏", "smirk", "flirt confident"],
      ["🙄", "eye roll", "doubt whatever"],
      ["😬", "grimace", "awkward teeth"],
      ["🤥", "liar pinocchio", "lie"],
      ["😌", "relieved", "calm peace"],
      ["😔", "pensive", "sad thoughtful"],
      ["😪", "sleepy", "tired"],
      ["🤤", "drooling", "hungry desire"],
      ["😴", "sleeping", "zzz night"],
      ["😷", "mask", "sick doctor"],
      ["🤒", "thermometer", "fever ill"],
      ["🤕", "bandage", "hurt injured"],
      ["🤢", "nauseated", "gross sick"],
      ["🤮", "vomiting", "sick throw up"],
      ["🥵", "hot face", "heat sweaty"],
      ["🥶", "cold face", "freezing shiver"],
      ["😵", "dizzy", "spun knocked"],
      ["🤯", "exploding head", "mind blown shock"],
      ["🥳", "party", "celebrate hooray"],
      ["😎", "sunglasses", "cool swagger"],
      ["🤓", "nerd", "geek glasses"],
      ["🧐", "monocle", "inspecting curious"],
      ["😕", "confused", "unsure huh"],
      ["🫤", "disappointed", "meh doubt"],
      ["😟", "worried", "concerned"],
      ["🙁", "frowning", "sad slight"],
      ["😮", "open mouth", "wow surprise"],
      ["😯", "hushed", "stunned quiet"],
      ["😲", "astonished", "amazed shock"],
      ["😳", "flushed", "embarrassed blush"],
      ["🥺", "pleading", "puppy eyes please"],
      ["😦", "frowning open", "aw"],
      ["😧", "anguished", "horror"],
      ["😨", "fearful", "scared afraid"],
      ["😰", "anxious sweat", "nervous"],
      ["😥", "sad relieved", "phew"],
      ["😢", "crying", "tear sad"],
      ["😭", "sobbing", "crying hard"],
      ["😱", "screaming", "fear shock"],
      ["😖", "confounded", "frustrated"],
      ["😣", "persevering", "struggling"],
      ["😞", "disappointed", "sad fail"],
      ["😓", "down sweat", "hard work"],
      ["😩", "weary", "tired exhausted"],
      ["😫", "tired face", "whine"],
      ["🥱", "yawning", "sleepy bored"],
      ["😤", "triumph steam", "annoyed proud"],
      ["😡", "angry", "mad rage"],
      ["😠", "enraged", "anger"],
      ["🤬", "cursing", "swear angry"],
      ["😈", "devil smile", "mischievous"],
      ["👿", "devil", "angry horns"],
      ["💀", "skull", "dead die"],
      ["💩", "poop", "crap hate"],
      ["🤡", "clown", "joke silly"],
      ["🤖", "robot", "ai bot machine"],
      ["👻", "ghost", "boo spooky"],
    ],
  },
  {
    id: "gestures",
    label: "Hands",
    icon: "👍",
    items: [
      ["👋", "waving hand", "hello bye hi"],
      ["🤚", "raised hand", "stop halt"],
      ["✋", "hand", "stop high five"],
      ["🖐", "spread hand", "five palm"],
      ["👌", "ok", "perfect yes"],
      ["🤌", "pinched fingers", "italian what"],
      ["🤏", "tiny", "little small"],
      ["✌️", "victory", "peace two"],
      ["🤞", "crossed fingers", "luck hope"],
      ["🫰", "finger heart", "love money snap"],
      ["🤟", "love you", "sign rock"],
      ["🤘", "horns", "rock metal"],
      ["🤙", "call me", "shirley hang up"],
      ["👈", "point left", "this way"],
      ["👉", "point right", "this way"],
      ["👆", "point up", "above"],
      ["👇", "point down", "below"],
      ["☝️", "index up", "one attention"],
      ["🫵", "point at you", "finger gun"],
      ["👍", "thumbs up", "yes like agree ok"],
      ["👎", "thumbs down", "no dislike bad"],
      ["✊", "fist", "power solidarity"],
      ["👊", "oncoming fist", "punch hit"],
      ["🤛", "left fist", "bump"],
      ["🤜", "right fist", "bump"],
      ["👏", "clapping", "applause bravo well done"],
      ["🙌", "raising hands", "celebrate praise"],
      ["🫶", "heart hands", "love thank you"],
      ["👐", "open hands", "give"],
      ["🤲", "palms up", "pray offer"],
      ["🤝", "handshake", "deal agree"],
      ["🙏", "folded hands", "please thanks pray namaste"],
      ["✍️", "writing", "note sign"],
      ["💅", "nails", "sassy flourish"],
      ["👀", "eyes", "look see watch"],
      ["👁", "eye", "watching"],
      ["🧠", "brain", "smart idea think"],
      ["🫀", "heart anatomical", "organ"],
      ["❤️", "red heart", "love like"],
    ],
  },
  {
    id: "animals",
    label: "Nature",
    icon: "🐶",
    items: [
      ["🐶", "dog", "puppy woof pet"],
      ["🐱", "cat", "kitten meow pet"],
      ["🐭", "mouse", "rat"],
      ["🐹", "hamster", "pet"],
      ["🐰", "rabbit", "bunny hare"],
      ["🦊", "fox", "sly"],
      ["🐻", "bear", "hug"],
      ["🐼", "panda", "bamboo"],
      ["🐨", "koala", "bear"],
      ["🐯", "tiger", "roar"],
      ["🦁", "lion", "king roar"],
      ["🐮", "cow", "moo"],
      ["🐷", "pig", "oink"],
      ["🐸", "frog", "ribbit"],
      ["🐵", "monkey", "ape"],
      ["🐔", "chicken", "hen"],
      ["🐧", "penguin", "cold"],
      ["🐦", "bird", "tweet"],
      ["🦅", "eagle", "bird"],
      ["🦆", "duck", "quack"],
      ["🦉", "owl", "night wise"],
      ["🦇", "bat", "vampire"],
      ["🐺", "wolf", "howl"],
      ["🐗", "boar", "pig"],
      ["🐴", "horse", "neigh"],
      ["🦄", "unicorn", "magic"],
      ["🐝", "bee", "honey buzz"],
      ["🐛", "caterpillar", "bug"],
      ["🦋", "butterfly", "moth"],
      ["🐌", "snail", "slow"],
      ["🐞", "lady beetle", "bug"],
      ["🐢", "turtle", "slow"],
      ["🐍", "snake", "hiss"],
      ["🦎", "lizard", "gecko"],
      ["🐙", "octopus", "ink"],
      ["🦀", "crab", "beach"],
      ["🐠", "fish tropical", "aqua"],
      ["🐟", "fish", "sea"],
      ["🐬", "dolphin", "sea"],
      ["🐳", "whale", "spout sea"],
      ["🦈", "shark", "jaws"],
      ["🐅", "tiger face", "roar"],
      ["🐎", "racehorse", "speed"],
      ["🦌", "deer", "stag"],
      ["🐓", "rooster", "cock"],
      ["🦃", "turkey", "thanksgiving"],
      ["🕊", "dove", "peace"],
      ["🐐", "goat", "greatest"],
      ["🌵", "cactus", "desert"],
      ["🎄", "christmas tree", "xmas holiday"],
      ["🌲", "evergreen tree", "pine forest"],
      ["🌸", "cherry blossom", "flower spring"],
      ["💐", "bouquet", "flowers love"],
      ["🌹", "rose", "flower love"],
      ["🌻", "sunflower", "flower"],
      ["🌼", "blossom", "flower"],
      ["🍀", "four leaf clover", "luck"],
      ["🍃", "leaf wind", "fall nature"],
      ["🌿", "herb", "leaf plant green"],
      ["🌍", "earth africa", "world globe"],
      ["🌙", "crescent moon", "night"],
      ["⭐", "star", "favorite"],
      ["🌟", "glowing star", "shine spark"],
      ["⚡", "bolt", "fast power"],
      ["🔥", "fire", "hot lit flames"],
      ["🌈", "rainbow", "pride color"],
      ["☀️", "sun", "sunny day"],
      ["❄️", "snowflake", "cold winter"],
    ],
  },
  {
    id: "food",
    label: "Food",
    icon: "🍕",
    items: [
      ["🍏", "green apple", "fruit"],
      ["🍎", "apple", "fruit"],
      ["🍊", "tangerine", "orange fruit"],
      ["🍋", "lemon", "sour citrus"],
      ["🍌", "banana", "fruit"],
      ["🍉", "watermelon", "fruit summer"],
      ["🍇", "grapes", "wine fruit"],
      ["🍓", "strawberry", "fruit"],
      ["🫐", "blueberries", "fruit"],
      ["🍒", "cherries", "fruit"],
      ["🥑", "avocado", "guacamole"],
      ["🍅", "tomato", "veg"],
      ["🥔", "potato", "veg"],
      ["🌽", "corn", "veg"],
      ["🥕", "carrot", "veg"],
      ["🌶", "pepper", "spicy hot"],
      ["🥦", "broccoli", "veg"],
      ["🧄", "garlic", "cook"],
      ["🧅", "onion", "cook"],
      ["🍄", "mushroom", "fungi"],
      ["🥒", "cucumber", "pickle"],
      ["🥐", "croissant", "bread bakery"],
      ["🍞", "bread", "loaf"],
      ["🥖", "baguette", "french bread"],
      ["🥨", "pretzel", "snack"],
      ["🥯", "bagel", "cream cheese"],
      ["🧀", "cheese", "wedge"],
      ["🥚", "egg", "breakfast"],
      ["🍳", "cooking egg", "fried breakfast"],
      ["🥞", "pancakes", "breakfast syrup"],
      ["🧇", "waffle", "breakfast"],
      ["🍔", "burger", "hamburger"],
      ["🍟", "fries", "chips"],
      ["🍕", "pizza", "slice cheese"],
      ["🌭", "hotdog", "frankfurter"],
      ["🥪", "sandwich", "lunch"],
      ["🌮", "taco", "mexican"],
      ["🌯", "burrito", "wrap mexican"],
      ["🍜", "ramen", "noodles soup"],
      ["🍝", "spaghetti", "pasta"],
      ["🍣", "sushi", "japanese fish"],
      ["🍛", "curry", "indian rice"],
      ["🍦", "ice cream", "dessert cone"],
      ["🍰", "cake slice", "dessert birthday"],
      ["🎂", "birthday cake", "celebrate"],
      ["🍪", "cookie", "biscuit"],
      ["🍫", "chocolate", "candy"],
      ["🍬", "candy", "sweet"],
      ["🍭", "lollipop", "candy"],
      ["🍯", "honey", "sweet pot"],
      ["☕", "coffee", "tea hot drink"],
      ["🍵", "green tea", "matcha drink"],
      ["🧃", "juice box", "drink"],
      ["🥤", "soda cup", "drink straw"],
      ["🍺", "beer", "pub drink"],
      ["🍻", "cheers beer", "clink drink"],
      ["🍷", "wine", "drink glass"],
      ["🥂", "clinking glasses", "cheers celebrate"],
      ["🍾", "champagne", "pop celebrate"],
      ["🥃", "whisky", "liquor glass"],
      ["🍹", "tropical drink", "cocktail"],
    ],
  },
  {
    id: "activities",
    label: "Activity",
    icon: "⚽",
    items: [
      ["⚽", "soccer", "football"],
      ["🏀", "basketball", "hoops"],
      ["🏈", "american football", "nfl"],
      ["⚾", "baseball", "bat"],
      ["🎾", "tennis", "racket"],
      ["🏐", "volleyball", "beach"],
      ["🏉", "rugby", "ball"],
      ["🎱", "pool", "billiards 8 ball"],
      ["🏓", "ping pong", "table tennis"],
      ["🏸", "badminton", "shuttle"],
      ["🥅", "goal net", "hockey soccer"],
      ["⛳", "golf", "hole flag"],
      ["🏹", "bow arrow", "archery"],
      ["🎣", "fishing", "rod"],
      ["🥊", "boxing", "glove fight"],
      ["🎯", "bullseye", "target darts"],
      ["🎲", "dice", "game random"],
      ["♟️", "chess", "pawn strategy"],
      ["🎮", "video game", "controller play"],
      ["🎰", "slot machine", "gamble jackpot"],
      ["🎭", "theatre", "masks drama"],
      ["🎨", "art palette", "paint create"],
      ["🎤", "microphone", "sing karaoke mic"],
      ["🎧", "headphones", "music listen"],
      ["🎼", "score", "music notes"],
      ["🎹", "piano", "keyboard music"],
      ["🥁", "drum", "music beat"],
      ["🎸", "guitar", "music rock"],
      ["🎺", "trumpet", "music jazz"],
      ["🎻", "violin", "music"],
      ["🏃", "runner", "exercise run"],
      ["🚴", "cycling", "bike"],
      ["🏋️", "weightlifting", "gym"],
      ["🤸", "cartwheel", "gymnastics"],
      ["🏊", "swimming", "pool"],
      ["🧗", "climbing", "wall"],
      ["🎽", "running shirt", "race"],
      ["🏅", "medal", "award winner"],
      ["🥇", "gold medal", "first winner"],
      ["🏆", "trophy", "champion win"],
      ["🎖", "military medal", "honor"],
      ["🎪", "circus", "tent show"],
      ["🎬", "clapper board", "movie film"],
      ["🎉", "tada", "party celebrate congrats"],
      ["🎊", "confetti ball", "celebrate"],
      ["🎁", "gift", "present birthday"],
      ["🎈", "balloon", "party"],
      ["🎵", "music note", "song"],
      ["🎶", "music notes", "song tune"],
      ["➡️", "arrow right", "next go"],
      ["🔝", "top", "best up"],
    ],
  },
  {
    id: "hearts",
    label: "Hearts",
    icon: "❤️",
    items: [
      ["❤️", "red heart", "love like"],
      ["🧡", "orange heart", "care"],
      ["💛", "yellow heart", "friendship"],
      ["💚", "green heart", "nature eco"],
      ["💙", "blue heart", "trust"],
      ["💜", "purple heart", "love"],
      ["🖤", "black heart", "dark"],
      ["🤍", "white heart", "pure wedding"],
      ["🤎", "brown heart", "warm"],
      ["💔", "broken heart", "heartbreak sad"],
      ["❤️‍🔥", "heart on fire", "passion"],
      ["❤️‍🩹", "mending heart", "healing recovery"],
      ["❣️", "heart exclamation", "soon"],
      ["💕", "two hearts", "love"],
      ["💞", "revolving hearts", "love spin"],
      ["💓", "beating heart", "pulse love"],
      ["💗", "growing heart", "love"],
      ["💖", "sparkling heart", "love shine"],
      ["💘", "cupid", "arrow love struck"],
      ["💝", "gift heart", "present love"],
      ["💟", "heart decoration", "love"],
      ["💌", "love letter", "message"],
      ["💋", "kiss mark", "lips"],
      ["👑", "crown", "king queen royal"],
      ["💎", "gem", "diamond jewel"],
      ["🔔", "bell", "notification ring"],
      ["✨", "sparkles", "shine star magic"],
      ["🌟", "star", "glow shine"],
    ],
  },
  {
    id: "objects",
    label: "Objects",
    icon: "💡",
    items: [
      ["💡", "idea", "bulb light think"],
      ["🔍", "magnifying glass", "search look"],
      ["🔎", "magnifying glass tilted", "search"],
      ["📌", "pin", "note stick"],
      ["📍", "round pin", "location here"],
      ["✅", "check mark", "yes done correct"],
      ["☑️", "checkbox", "done task"],
      ["✔️", "heavy check", "yes ok"],
      ["❌", "cross", "no wrong cancel"],
      ["❎", "cross box", "no"],
      ["⚠️", "warning", "caution danger"],
      ["🚫", "prohibited", "no ban"],
      ["❓", "question", "what ask"],
      ["❗", "exclamation", "important bang"],
      ["💯", "hundred", "perfect keep it real"],
      ["🔔", "bell", "ring notify"],
      ["🔕", "bell off", "mute silent"],
      ["🎵", "note", "music"],
      ["⏰", "alarm clock", "time wake"],
      ["⌛", "hourglass", "wait time"],
      ["📅", "calendar", "date schedule"],
      ["📆", "tear off calendar", "date"],
      ["🗓", "spiral calendar", "plan"],
      ["📋", "clipboard", "list task"],
      ["📝", "memo", "write note"],
      ["✏️", "pencil", "write edit"],
      ["📚", "books", "read study"],
      ["📖", "open book", "read story"],
      ["📰", "news", "paper press"],
      ["📎", "paperclip", "attach"],
      ["📁", "folder", "file"],
      ["💻", "laptop", "computer work"],
      ["🖥", "desktop", "computer"],
      ["📱", "phone", "mobile cell"],
      ["☎️", "phone", "telephone call"],
      ["📞", "receiver", "call ring"],
      ["📷", "camera", "photo"],
      ["📸", "camera flash", "photo snap"],
      ["🎥", "movie camera", "video record"],
      ["🔋", "battery", "power energy"],
      ["🔌", "plug", "charge power"],
      ["💰", "money bag", "cash rich"],
      ["💵", "dollar", "money cash"],
      ["💳", "card", "payment bank"],
      ["🧾", "receipt", "invoice bill"],
      ["🚀", "rocket", "launch ship grow"],
      ["✈️", "airplane", "flight travel"],
      ["🚗", "car", "drive"],
      ["🚌", "bus", "transit"],
      ["🏠", "house", "home"],
      ["🏢", "office", "building work"],
      ["🏖", "beach", "vacation umbrella"],
      ["🎉", "party", "celebrate"],
      ["🥂", "cheers", "congrats toast"],
      ["🙌", "praise", "celebrate hands"],
      ["💪", "muscle", "strong gym flex"],
      ["🧠", "brain", "smart idea"],
      ["👏", "clap", "applause bravo"],
      ["🤝", "handshake", "deal thanks"],
      ["🫂", "people hugging", "support sorry"],
      ["😴", "sleep", "night tired"],
      ["☕", "coffee", "break chat"],
    ],
  },
];

function toEntry([char, name, keywords]: RawEmoji): EmojiEntry {
  return { char, name, haystack: `${name} ${keywords ?? ""}`.toLowerCase() };
}

export const EMOJI_CATEGORIES: EmojiCategory[] = RAW.map((category) => ({
  id: category.id,
  label: category.label,
  icon: category.icon,
  emojis: category.items.map(toEntry),
}));

/** Everything, flattened — the pool a search runs over. */
export const ALL_EMOJIS: EmojiEntry[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/**
 * The bar shown without opening the picker. Longer than the five or six each
 * surface used to hardcode, short enough to stay one row on a phone; the picker
 * behind it covers everything else.
 */
export const QUICK_REACTIONS = ["❤️", "😂", "👏", "🙏", "🔥", "🎉", "👍", "😮", "😢", "💡"];

/**
 * The same idea sized for the strip under a call, which is one row on a phone
 * and has no picker behind it. It used to be five hardcoded glyphs.
 */
export const CALL_REACTIONS = ["❤️", "😂", "👏", "🙏", "🔥", "🎉", "👍", "😮"];

/**
 * The tap bar inside a live Space. Kept here with the other bars so one change
 * to the shared set is visible to every surface, and so the room cannot drift
 * into glyphs the picker does not know.
 *
 * 💰 is deliberately absent: that one belongs to a settled tip, not to a tap.
 */
export const SPACE_REACTIONS = ["❤️", "🔥", "👏", "🙌", "🚀", "💡", "💯", "🎉"];

/** What the room throws up when a tip lands. Not a choice a person can tap. */
export const TIP_REACTION = "💰";

/** Storage key for the device's recents, exported so tests can name the concept. */
export const RECENT_EMOJI_STORAGE_KEY = "starpace:recent-emoji";

/** How many recents the picker keeps and shows. */
export const MAX_RECENT_EMOJI = 28;

/** An emoji is a couple of code points at most; anything longer is not one. */
export const MAX_EMOJI_CHARS = 8;

/**
 * A reaction must be an emoji, not a paragraph. `message_reactions.emoji` is
 * plain `text` with no check on it, and the value is rendered straight into the
 * thread, so the boundary is enforced here rather than trusted from the UI.
 */
export function sanitizeReactionEmoji(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/[\r\n\t]/g, "").trim();
  if (!trimmed) return "";
  const chars = Array.from(trimmed);
  return chars.length > MAX_EMOJI_CHARS ? chars.slice(0, MAX_EMOJI_CHARS).join("") : trimmed;
}

/** Query normalisation: what a search term has to be to mean anything. */
export function normalizeSearchTerm(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Find emojis for a term.
 *
 * Every word must match something (so "red heart" does not return every heart),
 * and a name that *starts* with the term ranks above one that merely contains it
 * — typing "laugh" should hand you 😂 and 🤣 before 😆.
 */
export function searchEmojis(query: string, limit = 40): EmojiEntry[] {
  const term = normalizeSearchTerm(query);
  if (!term) return [];
  const words = term.split(" ");
  const scored: Array<{ entry: EmojiEntry; score: number }> = [];

  for (const entry of ALL_EMOJIS) {
    if (!words.every((word) => entry.haystack.includes(word) || entry.name.includes(word))) {
      continue;
    }
    let score = 3;
    if (entry.name === term) score = 0;
    else if (entry.name.startsWith(term)) score = 1;
    else if (entry.haystack.startsWith(term)) score = 2;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length);
  return scored.slice(0, Math.max(0, limit)).map((row) => row.entry);
}

/**
 * Insert at the front, drop duplicates, keep the newest `cap`.
 *
 * Recents are device-local on purpose: they are a typing shortcut like a
 * keyboard's own history, not a per-account setting, and storing them in
 * `user_preferences` would mean a migration and a round trip for twenty glyphs.
 */
export function pushRecent(
  recents: readonly string[],
  char: string,
  cap = MAX_RECENT_EMOJI,
): string[] {
  const emoji = sanitizeReactionEmoji(char);
  if (!emoji) return [...recents];
  return [emoji, ...recents.filter((c) => c !== emoji)].slice(0, Math.max(1, cap));
}

/** Read the saved recents defensively: the payload is somebody's localStorage. */
export function parseRecentEmojis(stored: string | null, cap = MAX_RECENT_EMOJI): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => sanitizeReactionEmoji(value))
      .filter(Boolean)
      .slice(0, cap);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                                 caret-aware                               */
/* -------------------------------------------------------------------------- */

/** The part of a text field a picker has to know about to insert into it. */
export interface CaretInsertOptions {
  /** What is in the field right now. */
  text: string;
  /** The glyph to place. */
  insert: string;
  /**
   * `selectionStart` as the browser reported it, or `null` when the field has
   * never had focus — which means "put it at the end", the one case where
   * appending really is what a person expects.
   */
  start?: number | null;
  /** `selectionEnd`: a live selection is replaced, exactly as typing would. */
  end?: number | null;
  /**
   * Ceiling on the result, counted in code points — the same unit Postgres
   * `char_length()` and `messageLength()` use, so a picker cannot smuggle a
   * draft past a cap the keyboard is held to.
   */
  maxLength?: number;
}

/** The new text and where the caret belongs afterwards. */
export interface CaretInsertResult {
  text: string;
  caret: number;
}

/**
 * Put a picked emoji where the caret is, not at the end of the line.
 *
 * Appending is the thing people notice: type "see you ", pick 🙏, then carry on
 * with "at 8" and the glyph sits after "8". Every surface that lets you choose
 * an emoji into a field goes through here so the behaviour is decided once — the
 * message composer had this, the post composer and story replies did not.
 *
 * Returns `null` when nothing should happen: an empty glyph, or a result past
 * `maxLength`. Refusing is deliberate — half an emoji is worse than none, and a
 * field that is already over its limit shows its own counter.
 */
export function insertAtCaret(options: CaretInsertOptions): CaretInsertResult | null {
  const text = String(options.text ?? "");
  const insert = String(options.insert ?? "");
  if (!insert) return null;

  const limit = text.length;
  // A stale ref or a hand-built selection can report anything, including an
  // index past the text it describes, so both edges are clamped before use.
  const rawStart = options.start == null ? limit : Math.trunc(Number(options.start));
  const rawEnd = options.end == null ? rawStart : Math.trunc(Number(options.end));
  let start = clampIndex(Number.isFinite(rawStart) ? rawStart : limit, limit);
  let end = Math.max(start, clampIndex(Number.isFinite(rawEnd) ? rawEnd : start, limit));

  // `selectionStart` counts UTF-16 units, and an emoji is usually two of them.
  // Landing between a high surrogate and its low half would splice the pair and
  // leave a replacement glyph in the middle of somebody's sentence.
  if (isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
    // After the move, not before: a selection whose far edge sat at the same
    // broken index would otherwise stay behind its near edge, and the slice
    // would copy the low half of the glyph out twice.
    end = Math.max(start, end);
  }

  const next = `${text.slice(0, start)}${insert}${text.slice(end)}`;
  if (options.maxLength != null && Array.from(next).length > options.maxLength) return null;
  return { text: next, caret: start + insert.length };
}

/**
 * Put the caret back after a programmatic insert.
 *
 * Structural rather than an `HTMLElement`, because a React ref to an input and a
 * fake in a test both satisfy it — and because setting `selectionRange` on a
 * field that is not focused does nothing at all, which is the half of this bug
 * that shows up as "the emoji went in but I lost my place".
 */
export function restoreCaret(
  field: { focus: () => void; setSelectionRange: (start: number, end: number) => void } | null,
  caret: number,
): void {
  if (!field) return;
  field.focus();
  field.setSelectionRange(caret, caret);
}

function clampIndex(value: number, limit: number): number {
  if (!Number.isFinite(value)) return limit;
  return Math.min(Math.max(value, 0), limit);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
