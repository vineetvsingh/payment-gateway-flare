/*
 * Message filter for donation alerts. Whatever a donor types is shown on a live stream and read
 * aloud, so it is cleaned first: swear words are masked, links removed, and spammy repetition cut
 * down. A message that needed masking is "flagged" and waits for the streamer's approval.
 *
 * Word lists like this can never be complete. Streamers add their own words, and can switch to
 * approving every message by hand.
 */

const DEFAULT_BLOCKED = [
  // English
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'slut', 'whore', 'pussy',
  'nigga', 'faggot', 'retard',
  // Hindi / Hinglish
  'chutiya', 'chutiye', 'madarchod', 'behenchod', 'bhenchod', 'bhosdi', 'bhosdike', 'bhosdiwale', 'gandu', 'randi',
  'harami', 'lauda', 'lavda', 'lund', 'chod', 'chodu', 'kutta', 'kamina', 'mc', 'bc',
  // Hindi in Devanagari
  'चूतिया', 'चुतिया', 'चूतिये', 'मादरचोद', 'बहनचोद', 'भेनचोद', 'भोसड़ी', 'भोसड़ीके', 'भोसड़ीवाले', 'गांडू', 'गांडु',
  'गाण्डू', 'रंडी', 'हरामी', 'लौड़ा', 'लवड़ा', 'लंड', 'चोद', 'चोदू', 'कुत्ता', 'कमीना', 'कमीने',
];

/** Undoes the usual tricks: "f.u.c.k", "sh1t", "$hit", "fuuuuck", and "ड़" typed with or without its dot. */
function normalize(word: string): string {
  return word
    .normalize('NFC')
    .replace(/़/g, '') // Devanagari nukta
    .toLowerCase()
    .replace(/[0@4]/g, (c) => ({ 0: 'o', '@': 'a', 4: 'a' })[c]!)
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^\p{L}\p{M}]/gu, '') // \p{M}: Devanagari vowel signs
    .replace(/(.)\1+/g, '$1');
}

export function parseBlockedWords(list: string): string[] {
  return list.split(/[,\n]/).map((w) => normalize(w.trim())).filter((w) => w.length >= 2);
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|in|net|org|io|gg|tv|me|xyz|co|ly|link)(?:\/\S*)?\b/gi;

export interface Moderated {
  /** Safe to show and read aloud. */
  text: string;
  /** Something had to be masked or removed, so a person should look before it goes on stream. */
  flagged: boolean;
}

export function moderate(input: string, extraBlocked: string[] = []): Moderated {
  let flagged = false;
  let text = input
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(URL_PATTERN, () => {
    flagged = true;
    return '[link removed]';
  });

  // "soooooo goooood" -> "sooo goood": keeps the feeling, stops the text-to-speech droning on.
  text = text.replace(/(.)\1{3,}/gu, '$1$1$1');

  const blocked = new Set([...DEFAULT_BLOCKED.map(normalize), ...extraBlocked]);
  text = text.replace(/[\p{L}\p{M}\p{N}@$!|.*_-]+/gu, (token) => {
    const n = normalize(token);
    const hit = n.length >= 2 && [...blocked].some((w) => n === w || (w.length >= 4 && n.includes(w)));
    if (!hit) return token;
    flagged = true;
    return '*'.repeat(Math.min(token.length, 8));
  });

  return { text, flagged };
}

/** What the voice should say: masked words and removed links are skipped rather than read out. */
export function spokenText(text: string): string {
  return text.replace(/\*+/g, ' ').replace(/\[link removed\]/g, ' ').replace(/\s+/g, ' ').trim();
}
