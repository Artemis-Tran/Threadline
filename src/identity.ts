// Shared character name/alias normalization and identity-matching logic,
// used by both extract-book.ts (stage 3's roster hint) and merge-thread.ts
// (stage 4's authoritative merge) so the two never drift.

// Pronoun and possessive-relational aliases ("him", "his brother", "our son")
// are contextual, not identifying, and chain unrelated characters together
// when matched on.
export const GENERIC_ALIAS =
  /^(he|she|him|her|his|hers|they|them|it|(his|her|our|their|my|its) .+)$/i;

// A "the ..." alias is only an identity key when it's a distinctive, capitalized
// epithet ("the Reaper", "the Mystic Potter"). A lowercase "the ..." is a shared
// role/title ("the guard", "the captain", "the merchant") that many different
// characters answer to, so it must not become a matchable alias — otherwise two
// differently-named characters get fused via the shared title.
export function isGenericAlias(alias: string): boolean {
  if (GENERIC_ALIAS.test(alias)) return true;
  const the = alias.match(/^the\s+(\S+)/i);
  return the !== null && /^[a-z]/.test(the[1]);
}

// The model occasionally emits parenthetical disambiguation in names
// ("Marcus (blacksmith's apprentice)"); ingesting that verbatim makes any
// downstream identity index echo it back and compound across chapters.
export function sanitizeName(raw: string): string {
  const paren = raw.indexOf("(");
  return (paren === -1 ? raw : raw.slice(0, paren)).trim();
}

export function sanitizeAliases(name: string, rawAliases: string[]): string[] {
  const seen = new Set([name.toLowerCase()]);
  const aliases: string[] = [];
  for (const raw of rawAliases) {
    const alias = sanitizeName(raw);
    if (
      alias.length === 0 ||
      alias.length > 40 ||
      isGenericAlias(alias) ||
      seen.has(alias.toLowerCase())
    ) {
      continue;
    }
    seen.add(alias.toLowerCase());
    aliases.push(alias);
  }
  return aliases;
}

export interface Identified {
  name: string;
  aliases: string[];
}

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

// Honorifics/titles carry no identity on their own — many different people
// answer to "Lady" or "Lord" — so they must not count as a shared token when
// clustering owner names in collectNonIdentifyingKeys below. Without this,
// "Lady Isabel Ruesta" and "Lady Ferranda Villazur" would collapse into one
// cluster via the shared "lady" token, hiding the fact that a bridging alias
// ("infanzona") spans two genuinely different people.
export const HONORIFIC_TOKENS: ReadonlySet<string> = new Set([
  "the", "lady", "lord", "master", "mistress", "sir", "dame", "young", "old",
  "elder", "madam", "madame", "miss", "mister", "mr", "mrs", "ms", "saint", "st",
]);

// Split a name into lowercased word tokens, diacritic-safe: NFC-normalize first
// so a composed accented letter and its decomposed (letter + combining mark)
// form tokenize identically — otherwise the combining mark (\p{M}, not in
// \p{L}/\p{N}) would act as a separator and split the two forms differently.
// Unicode letters and numbers are token characters; everything else separates.
export function tokenize(name: string): string[] {
  return name
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// The identifying (non-honorific) tokens of a name — the actual name parts,
// with titles like "Lady"/"Lord" removed. Used both for owner-name clustering
// here and for canonical-name selection in merge-thread.ts.
export function identifyingTokens(name: string): Set<string> {
  return new Set(tokenize(name).filter((t) => !HONORIFIC_TOKENS.has(t)));
}

// Count how many token-disjoint clusters a set of owner names forms, matching
// only on identifying (non-honorific) tokens. "Henry"/"Henry Ashford" share
// "henry" → 1 cluster; "Yaotl Cuatzo"/"Tupoc Xical"/"Yaretzi" share nothing → 3.
function countNameClusters(names: string[]): number {
  const parent = names.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tokenSets = names.map(identifyingTokens);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      for (const t of tokenSets[i]) {
        if (tokenSets[j].has(t)) {
          parent[find(i)] = find(j);
          break;
        }
      }
    }
  }
  return new Set(names.map((_, i) => find(i))).size;
}

// A string is "non-identifying" when it bridges people whose *names* are
// otherwise unrelated — whether it shows up as a shared descriptive epithet
// ("the Izcalli") or as an alias that collides with a different person's real
// name ("Ju" listed as an alias of Lan). Derived from the book itself, no
// hardcoded epithet list.
//
// For each candidate string, gather the distinct owner names that hold it as a
// name OR an alias (name-holders included so alias-to-name collisions are
// caught), then cluster those names by identifying-token overlap. Spanning ≥2
// disjoint clusters means the string links unrelated people, so it must not be
// used as a matching key. A record's own *name* is never removed from matching
// (identifierSet always keeps the name) — only demoted alias occurrences are.
export function collectNonIdentifyingKeys(records: readonly Identified[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  const add = (raw: string, ownerName: string): void => {
    const key = raw.toLowerCase();
    let set = owners.get(key);
    if (!set) owners.set(key, (set = new Set()));
    set.add(ownerName.toLowerCase());
  };
  for (const rec of records) {
    add(rec.name, rec.name);
    for (const alias of rec.aliases) add(alias, rec.name);
  }

  const nonIdentifying = new Set<string>();
  for (const [key, ownerNames] of owners) {
    if (ownerNames.size < 2) continue;
    if (countNameClusters([...ownerNames]) >= 2) nonIdentifying.add(key);
  }
  return nonIdentifying;
}

// The matching identifier set: the name is ALWAYS included (a record's own name
// is never demoted), plus every alias except those flagged non-identifying.
export function identifierSet(
  entity: Identified,
  nonIdentifying: ReadonlySet<string> = EMPTY_KEY_SET
): Set<string> {
  const ids = new Set<string>([entity.name.toLowerCase()]);
  for (const alias of entity.aliases) {
    const key = alias.toLowerCase();
    if (!nonIdentifying.has(key)) ids.add(key);
  }
  return ids;
}

// The overlap predicate used to decide "same person": true if the candidate's
// and known entity's matching identifier sets intersect. Bare-name identity is
// trusted deliberately (see extract-book.ts's updateRoster comment) —
// over-merging here is cheap, a fragmented roster is not. The rarer opposite
// case (two different characters sharing a bare name) is a known, documented
// limitation left unresolved by this predicate. `nonIdentifying` (default
// empty, preserving stage-3's behavior) drops bridging aliases from matching.
export function identityOverlaps(
  candidate: Identified,
  known: Identified,
  nonIdentifying: ReadonlySet<string> = EMPTY_KEY_SET
): boolean {
  const candidateIds = identifierSet(candidate, nonIdentifying);
  for (const id of identifierSet(known, nonIdentifying)) {
    if (candidateIds.has(id)) return true;
  }
  return false;
}

// Finds the first entity in `pool` (insertion order) whose identifiers overlap
// the candidate's, or undefined. Pure — never mutates `pool`; the caller
// decides what "match" means to do (extend an entry, cap aliases, replace
// description, keep full history, etc).
export function findIdentityMatch<T extends Identified>(
  candidate: Identified,
  pool: readonly T[],
  nonIdentifying: ReadonlySet<string> = EMPTY_KEY_SET
): T | undefined {
  return pool.find((known) => identityOverlaps(candidate, known, nonIdentifying));
}
