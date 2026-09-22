// Type declarations for the ported offline profanity filter (profanity.js).
// The implementation (normalisation + multilingual deny-lists) lives in the .js
// so the word data stays out of the typed sources. Adapted from the
// Vocabulary Race filter (MIT).
export function isClean(name: string): boolean;
export function clean(name: string, fb?: string): string;
export function foldLatin(s: string): string;
export function foldCyr(s: string): string;
