// Shared types for the wine night app.

/** Phases of the evening. */
export type Phase = "setup" | "tasting" | "revealed";

/** How a participant chose to input their rating. */
export type Mode = "ranked" | "numeric" | "top3";

export type Wine = {
  id: string;
  /** Physical bag number shown throughout tasting, e.g. "3". */
  blindCode: string;
  /** Hidden until reveal. */
  name: string;
  producer: string;
  price: number; // dollars, used for "best value"
  /** Contribution order / the couple that brought it. */
  broughtBy: string;
};

export type Participant = {
  id: string;
  name: string;
  isHost: boolean;
  mode?: Mode;
  numericMax?: number;
  hasSubmitted?: boolean;
};

/** Raw rating stored per participant per wine. */
export type Rating = {
  participantId: string;
  wineId: string;
  /** Raw value: place, participant-selected numeric score, or 1-3 (top3). */
  value: number;
};
