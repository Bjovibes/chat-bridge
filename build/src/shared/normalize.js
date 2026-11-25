'use strict';

// Chat Bridge - shared title normalization for chat titles.
// KEEP IN SYNC: the exact same three functions are inlined in
//   src/main/inject/privacy-inject.js
//   src/main/inject/context-scraper.js
// (the page world cannot require). Change all three copies together.

// Emoji strip. Preferred: Unicode property escape. Fallback: explicit ranges.
var EMOJI_RE = (function () {
  try { return new RegExp('[\\p{Extended_Pictographic}]', 'gu'); }
  catch (e) { return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu; }
})();

// Punctuation, symbols, marks, control/format chars (after emoji removal).
var STRIP_RE = (function () {
  try { return new RegExp('[\\p{P}\\p{S}\\p{M}\\p{C}]', 'gu'); }
  catch (e) { return /[ -⁯⸀-⹿︀-️‍]/gu; }
})();

// Digit sequences (any script), joined without separators.
var DIGITS_RE = (function () {
  try { return new RegExp('[\\p{Nd}]+', 'gu'); }
  catch (e) { return /[0-9]+/g; }
})();

// lowercase, strip emoji / diacritics / punctuation, collapse whitespace.
function normalizeTitle(str) {
  if (typeof str !== 'string') return '';
  var t = str.normalize('NFD')
    .replace(/[̀-ͯ]/g, '')       // combining marks left over from NFD
    .replace(/[‍︎️]/g, '')  // ZWJ and variation selectors
    .toLowerCase()
    .replace(/\s+/g, ' ');
  t = t.replace(EMOJI_RE, '')
       .replace(STRIP_RE, '')
       .replace(/\s+/g, ' ')
       .trim();
  return t;
}

// All digit characters of the string, concatenated: '+32 499 00 00 00' -> '32478221105'.
function digitsOnly(str) {
  if (typeof str !== 'string') return '';
  var m = str.match(DIGITS_RE);
  return m ? m.join('') : '';
}

// Match two chat titles as the same chat.
// 1. exact equality after normalization
// 2. startsWith either way, when the shorter side is at least 5 chars
// 3. equal digit sequences, when both contain at least 6 digits (phone numbers)
function titlesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var na = normalizeTitle(a);
  var nb = normalizeTitle(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  if (na.length >= 5 && nb.indexOf(na) === 0) return true;
  if (nb.length >= 5 && na.indexOf(nb) === 0) return true;
  var da = digitsOnly(a);
  var db = digitsOnly(b);
  if (da.length >= 6 && db.length >= 6 && da === db) return true;
  return false;
}

module.exports = {
  normalizeTitle: normalizeTitle,
  digitsOnly: digitsOnly,
  titlesMatch: titlesMatch
};
