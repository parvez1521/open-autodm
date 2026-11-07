/**
 * Creator Studio — curated niche dataset (Programme S1).
 *
 * Original, hand-authored dataset of broad creator niches. The numbers are
 * RELATIVE indices (0–100) expressing how niches compare with each other on
 * demand, competition, ease of starting and earning potential — they are a
 * built-in heuristic, NOT live market data, and the UI labels them as such.
 * CPM bands are indicative INR ranges per 1,000 monetised views for an
 * Indian-audience channel, again as relative guidance only.
 */

import type { StudioCategory } from "./types";

export interface NicheEntry {
  id: string;
  name: string;
  category: StudioCategory;
  demand: number;
  competition: number;
  easeOfStarting: number;
  earningPotential: number;
  audienceBand: string;
  cpmBandInr: string;
  keywords: string[];
}

export const NICHE_DATASET: NicheEntry[] = [
  // ── Tech & AI Tools ────────────────────────────────────────────────
  {
    id: "ai-tools-reviews",
    name: "AI tools & tutorials",
    category: "Tech & AI Tools",
    demand: 92, competition: 78, easeOfStarting: 62, earningPotential: 74,
    audienceBand: "Large and fast-growing",
    cpmBandInr: "₹80–₹250",
    keywords: ["ai", "artificial intelligence", "chatgpt", "tools", "software", "apps", "automation"],
  },
  {
    id: "smartphone-tech",
    name: "Smartphones & gadgets",
    category: "Tech & AI Tools",
    demand: 88, competition: 90, easeOfStarting: 40, earningPotential: 58,
    audienceBand: "Massive",
    cpmBandInr: "₹40–₹120",
    keywords: ["smartphone", "phone", "gadgets", "iphone", "android", "unboxing", "review"],
  },
  {
    id: "coding-tutorials",
    name: "Programming tutorials",
    category: "Tech & AI Tools",
    demand: 76, competition: 64, easeOfStarting: 48, earningPotential: 82,
    audienceBand: "Large",
    cpmBandInr: "₹100–₹300",
    keywords: ["coding", "programming", "python", "javascript", "developer", "web dev", "coding tutorials"],
  },
  // ── Education ──────────────────────────────────────────────────────
  {
    id: "exam-prep",
    name: "Exam preparation",
    category: "Education",
    demand: 90, competition: 72, easeOfStarting: 55, earningPotential: 52,
    audienceBand: "Massive (seasonal peaks)",
    cpmBandInr: "₹30–₹90",
    keywords: ["exam", "upsc", "ssc", "neet", "jee", "board exam", "study", "preparation"],
  },
  {
    id: "spoken-english",
    name: "Spoken English & language skills",
    category: "Education",
    demand: 86, competition: 68, easeOfStarting: 66, earningPotential: 48,
    audienceBand: "Massive",
    cpmBandInr: "₹25–₹80",
    keywords: ["english", "spoken english", "language", "grammar", "ielts", "communication"],
  },
  {
    id: "study-productivity",
    name: "Study skills & productivity",
    category: "Education",
    demand: 64, competition: 52, easeOfStarting: 74, earningPotential: 44,
    audienceBand: "Growing",
    cpmBandInr: "₹30–₹90",
    keywords: ["productivity", "study tips", "focus", "notes", "routine", "habits"],
  },
  // ── Fitness ────────────────────────────────────────────────────────
  {
    id: "home-workouts",
    name: "Home workouts & weight loss",
    category: "Fitness",
    demand: 89, competition: 84, easeOfStarting: 58, earningPotential: 55,
    audienceBand: "Massive",
    cpmBandInr: "₹30–₹100",
    keywords: ["workout", "weight loss", "fat loss", "exercise", "home workout", "fitness"],
  },
  {
    id: "yoga-wellness",
    name: "Yoga & wellness",
    category: "Fitness",
    demand: 72, competition: 58, easeOfStarting: 70, earningPotential: 50,
    audienceBand: "Large",
    cpmBandInr: "₹30–₹90",
    keywords: ["yoga", "meditation", "wellness", "stretching", "breathing"],
  },
  {
    id: "gym-muscle",
    name: "Gym & muscle building",
    category: "Fitness",
    demand: 78, competition: 74, easeOfStarting: 46, earningPotential: 57,
    audienceBand: "Large",
    cpmBandInr: "₹35–₹110",
    keywords: ["gym", "muscle", "bodybuilding", "protein", "strength"],
  },
  // ── Finance & Business ─────────────────────────────────────────────
  {
    id: "personal-finance",
    name: "Personal finance & investing",
    category: "Finance & Business",
    demand: 84, competition: 70, easeOfStarting: 44, earningPotential: 95,
    audienceBand: "Large and growing",
    cpmBandInr: "₹150–₹450",
    keywords: ["finance", "investing", "stocks", "mutual funds", "money", "savings", "share market"],
  },
  {
    id: "online-earning",
    name: "Online earning & side hustles",
    category: "Finance & Business",
    demand: 91, competition: 82, easeOfStarting: 52, earningPotential: 60,
    audienceBand: "Massive",
    cpmBandInr: "₹40–₹130",
    keywords: ["earn online", "side hustle", "freelancing", "make money", "online income", "work from home"],
  },
  {
    id: "business-startups",
    name: "Business & startup explainers",
    category: "Finance & Business",
    demand: 68, competition: 55, easeOfStarting: 50, earningPotential: 85,
    audienceBand: "Growing",
    cpmBandInr: "₹120–₹350",
    keywords: ["business", "startup", "entrepreneur", "case study", "marketing"],
  },
  // ── Motivation ─────────────────────────────────────────────────────
  {
    id: "self-improvement",
    name: "Self-improvement & mindset",
    category: "Motivation",
    demand: 74, competition: 76, easeOfStarting: 72, earningPotential: 42,
    audienceBand: "Large",
    cpmBandInr: "₹25–₹80",
    keywords: ["motivation", "mindset", "self improvement", "discipline", "success", "habits"],
  },
  {
    id: "life-stories",
    name: "Biographies & life stories",
    category: "Motivation",
    demand: 66, competition: 48, easeOfStarting: 64, earningPotential: 40,
    audienceBand: "Growing",
    cpmBandInr: "₹20–₹70",
    keywords: ["biography", "life story", "documentary", "inspirational story"],
  },
  // ── Comedy & Entertainment ─────────────────────────────────────────
  {
    id: "comedy-skits",
    name: "Comedy skits & sketches",
    category: "Comedy & Entertainment",
    demand: 93, competition: 92, easeOfStarting: 38, earningPotential: 38,
    audienceBand: "Massive",
    cpmBandInr: "₹15–₹60",
    keywords: ["comedy", "funny", "skits", "sketch", "prank", "entertainment"],
  },
  {
    id: "movie-explainers",
    name: "Movie & series explainers",
    category: "Comedy & Entertainment",
    demand: 82, competition: 66, easeOfStarting: 56, earningPotential: 36,
    audienceBand: "Large",
    cpmBandInr: "₹15–₹55",
    keywords: ["movie", "explained", "recap", "web series", "film", "ending explained"],
  },
  {
    id: "faceless-stories",
    name: "Faceless story & facts channels",
    category: "Comedy & Entertainment",
    demand: 80, competition: 80, easeOfStarting: 68, earningPotential: 34,
    audienceBand: "Large",
    cpmBandInr: "₹12–₹50",
    keywords: ["faceless", "facts", "stories", "horror stories", "reddit stories", "mystery"],
  },
  // ── Food ───────────────────────────────────────────────────────────
  {
    id: "recipes-home",
    name: "Home recipes & cooking",
    category: "Food",
    demand: 87, competition: 78, easeOfStarting: 60, earningPotential: 45,
    audienceBand: "Massive",
    cpmBandInr: "₹25–₹80",
    keywords: ["recipe", "cooking", "food", "kitchen", "veg recipe", "snacks"],
  },
  {
    id: "street-food",
    name: "Street food & food travel",
    category: "Food",
    demand: 79, competition: 62, easeOfStarting: 42, earningPotential: 41,
    audienceBand: "Large",
    cpmBandInr: "₹20–₹70",
    keywords: ["street food", "food vlog", "food tour", "restaurant", "eating"],
  },
  // ── Travel ─────────────────────────────────────────────────────────
  {
    id: "budget-travel",
    name: "Budget travel & itineraries",
    category: "Travel",
    demand: 77, competition: 60, easeOfStarting: 36, earningPotential: 62,
    audienceBand: "Large",
    cpmBandInr: "₹50–₹160",
    keywords: ["travel", "trip", "budget travel", "itinerary", "tour", "vlog"],
  },
  {
    id: "travel-guides",
    name: "Destination guides",
    category: "Travel",
    demand: 70, competition: 57, easeOfStarting: 44, earningPotential: 66,
    audienceBand: "Growing",
    cpmBandInr: "₹55–₹170",
    keywords: ["guide", "places to visit", "destination", "honeymoon", "solo travel"],
  },
  // ── Beauty & Fashion ───────────────────────────────────────────────
  {
    id: "beauty-skincare",
    name: "Beauty & skincare",
    category: "Beauty & Fashion",
    demand: 85, competition: 81, easeOfStarting: 54, earningPotential: 63,
    audienceBand: "Massive",
    cpmBandInr: "₹45–₹140",
    keywords: ["beauty", "skincare", "makeup", "routine", "glow up", "fashion"],
  },
  // ── Gaming ─────────────────────────────────────────────────────────
  {
    id: "mobile-gaming",
    name: "Mobile gaming (BGMI / Free Fire)",
    category: "Gaming",
    demand: 94, competition: 88, easeOfStarting: 50, earningPotential: 33,
    audienceBand: "Massive",
    cpmBandInr: "₹12–₹45",
    keywords: ["bgmi", "free fire", "gaming", "gameplay", "pubg", "esports"],
  },
  {
    id: "gaming-explainers",
    name: "Gaming news & explainers",
    category: "Gaming",
    demand: 71, competition: 59, easeOfStarting: 58, earningPotential: 39,
    audienceBand: "Large",
    cpmBandInr: "₹18–₹60",
    keywords: ["gaming news", "gta", "minecraft", "game review", "walkthrough"],
  },
  // ── Music ──────────────────────────────────────────────────────────
  {
    id: "music-covers",
    name: "Music covers & performances",
    category: "Music",
    demand: 75, competition: 71, easeOfStarting: 34, earningPotential: 37,
    audienceBand: "Large",
    cpmBandInr: "₹15–₹55",
    keywords: ["cover", "singing", "music", "song", "guitar", "piano"],
  },
  {
    id: "music-production",
    name: "Music production tutorials",
    category: "Music",
    demand: 58, competition: 45, easeOfStarting: 40, earningPotential: 59,
    audienceBand: "Growing (loyal)",
    cpmBandInr: "₹45–₹130",
    keywords: ["music production", "fl studio", "mixing", "beat making", "producer"],
  },
  // ── DIY & Home ─────────────────────────────────────────────────────
  {
    id: "diy-crafts",
    name: "DIY, crafts & home hacks",
    category: "DIY & Home",
    demand: 73, competition: 56, easeOfStarting: 63, earningPotential: 47,
    audienceBand: "Large",
    cpmBandInr: "₹30–₹95",
    keywords: ["diy", "crafts", "home decor", "hacks", "handmade", "reuse"],
  },
  // ── Other ──────────────────────────────────────────────────────────
  {
    id: "podcast-clips",
    name: "Podcast & interview clips",
    category: "Other",
    demand: 69, competition: 51, easeOfStarting: 60, earningPotential: 54,
    audienceBand: "Growing",
    cpmBandInr: "₹35–₹110",
    keywords: ["podcast", "interview", "clips", "conversation"],
  },
  {
    id: "news-commentary",
    name: "News explainers & commentary",
    category: "Other",
    demand: 83, competition: 69, easeOfStarting: 52, earningPotential: 43,
    audienceBand: "Large (spiky)",
    cpmBandInr: "₹20–₹75",
    keywords: ["news", "current affairs", "explained", "commentary", "politics"],
  },
];
