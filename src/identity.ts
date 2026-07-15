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

export function identifierSet(entity: Identified): Set<string> {
  return new Set([entity.name.toLowerCase(), ...entity.aliases.map((a) => a.toLowerCase())]);
}

// The overlap predicate used to decide "same person": true if the candidate's
// name or any alias case-insensitively matches the known entity's name or any
// alias. Bare-name identity is trusted deliberately (see extract-book.ts's
// updateRoster comment) — over-merging here is cheap, a fragmented roster is
// not. The rarer opposite case (two different characters sharing a bare name)
// is a known, documented limitation left unresolved by this predicate.
export function identityOverlaps(candidate: Identified, known: Identified): boolean {
  const candidateIds = identifierSet(candidate);
  return (
    candidateIds.has(known.name.toLowerCase()) ||
    known.aliases.some((a) => candidateIds.has(a.toLowerCase()))
  );
}

// Finds the first entity in `pool` (insertion order) whose identifiers overlap
// the candidate's, or undefined. Pure — never mutates `pool`; the caller
// decides what "match" means to do (extend an entry, cap aliases, replace
// description, keep full history, etc).
export function findIdentityMatch<T extends Identified>(
  candidate: Identified,
  pool: readonly T[]
): T | undefined {
  return pool.find((known) => identityOverlaps(candidate, known));
}
