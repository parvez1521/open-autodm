/**
 * Meme sound effects for the Studio Library — the MyInstants-LINKED
 * route (owner's choice, 2026-11-07).
 *
 * Nothing here is hosted by this app: no audio file is copied,
 * proxied or hotlinked (no myinstants.com/media URLs anywhere). Each
 * entry links to the sound's canonical MyInstants page, and in-app
 * playback uses the OFFICIAL embed player MyInstants itself offers
 * on every sound page ("Embed this button to your site!"). Downloads
 * happen on MyInstants, under their terms.
 *
 * Every pageUrl below was opened and verified live on 2026-11-07;
 * `favorites` is the count MyInstants displayed that day. The embed
 * URL pattern (page slug under /instant/<slug>/embed/) was verified
 * against a live embed page the same day.
 */

export interface SoundEffect {
    name: string;
    /** One line: when an editor reaches for this sound. */
    use: string;
    category: "Impact" | "Reactions" | "Comedy" | "Drama";
    /** Favorites count as displayed on MyInstants, 2026-11-07. */
    favorites: number;
    /** Canonical MyInstants page for this sound. */
    pageUrl: string;
    /** Official MyInstants embed player for this sound. */
    embedUrl: string;
}

const page = (slug: string) => `https://www.myinstants.com/en/instant/${slug}/`;
const embed = (slug: string) => `https://www.myinstants.com/instant/${slug}/embed/`;

function sound(
    name: string,
    use: string,
    category: SoundEffect["category"],
    favorites: number,
    slug: string,
): SoundEffect {
    return { name, use, category, favorites, pageUrl: page(slug), embedUrl: embed(slug) };
}

export const SOUND_EFFECTS: SoundEffect[] = [
    sound("Vine Boom", "The reveal hit — a price drop, a plot twist, a before/after.", "Impact", 586501, "vine-boom-sound-70972"),
    sound("Bruh", "Deadpan reaction to anything dumb or unbelievable.", "Reactions", 446814, "bruh"),
    sound("Sad Violin", "Mock-tragic moments — a fail, a tiny violin for a small problem.", "Reactions", 337376, "sad-violin-the-meme-one"),
    sound("Anime Wow", "Sparkly amazement — a feature reveal or a glow-up.", "Reactions", 333304, "anime-wow"),
    sound("Fart", "The classic comedy puncture — deflates any serious moment.", "Comedy", 303825, "fart"),
    sound("Metal Pipe Clang", "A heavy object drops — literal or metaphorical.", "Impact", 252864, "metal-pipe-clang-80894"),
    sound("Bone Crack", "Crunch for breaks, snaps and chiropractor-grade edits.", "Impact", 175787, "bone-crack-23901"),
    sound("Dun Dun Duuun", "Dramatic sting — right before the shocking bit lands.", "Drama", 167696, "dun-dun-dunnnnnnnn-68584"),
    sound("Faaah", "The drawn-out scream for chaotic, unhinged moments.", "Comedy", 161944, "faaah-63455"),
    sound("Punch", "A single clean hit — transitions, slams, emphasis cuts.", "Impact", 130275, "punch-sound-86161"),
    sound("Shocked Sound", "Gasp sting for reveals nobody saw coming.", "Reactions", 123803, "shocked-sound-37548"),
    sound("Undertaker Bell", "The ominous toll — a doom drop or a final verdict.", "Drama", 123640, "the-undertaker-bell-30938"),
];

export const SOUND_EFFECT_CATEGORIES = ["All", "Impact", "Reactions", "Comedy", "Drama"] as const;

/** MyInstants' own search results page for sounds not in this list. */
export function myinstantsSearchUrl(query: string): string {
    return `https://www.myinstants.com/en/search/?name=${encodeURIComponent(query.trim())}`;
}

export function filterSoundEffects(query: string, category: string): SoundEffect[] {
    const q = query.trim().toLowerCase();
    return SOUND_EFFECTS.filter((s) => {
        if (category !== "All" && s.category !== category) return false;
        if (!q) return true;
        return s.name.toLowerCase().includes(q) || s.use.toLowerCase().includes(q);
    });
}
