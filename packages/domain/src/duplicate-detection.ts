/**
 * Probabilistic patient duplicate detection (PAT-003, pack §3.2, §6.1).
 *
 * Runs before creating a patient, against locally available records, and never
 * merges automatically — it surfaces likely matches with safe discriminators so
 * a human decides. "Never merge solely on name" (pack §21.5).
 */

export type PatientCandidate = {
  readonly id: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly dateOfBirth?: string; // ISO date, may be estimated
  readonly sex?: string;
  readonly phone?: string;
};

export type MatchResult = {
  readonly candidate: PatientCandidate;
  readonly score: number; // 0..1
  readonly reasons: readonly string[];
};

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Normalised Damerau-ish Levenshtein similarity in [0,1]. */
export function nameSimilarity(a: string, b: string): number {
  const s = normalise(a);
  const t = normalise(b);
  if (s.length === 0 && t.length === 0) return 1;
  if (s.length === 0 || t.length === 0) return 0;
  const d: number[][] = Array.from({ length: s.length + 1 }, () => new Array<number>(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) d[i]![0] = i;
  for (let j = 0; j <= t.length; j++) d[0]![j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  const dist = d[s.length]![t.length]!;
  return 1 - dist / Math.max(s.length, t.length);
}

function digits(s: string | undefined): string {
  return (s ?? '').replace(/\D+/g, '');
}

/**
 * Score a candidate against an incoming registration. Weighted blend of name,
 * date of birth, sex and phone. Exact phone or exact DOB strongly boosts score.
 */
export function scoreCandidate(
  incoming: Omit<PatientCandidate, 'id'>,
  candidate: PatientCandidate,
): MatchResult {
  const reasons: string[] = [];
  const given = nameSimilarity(incoming.givenName, candidate.givenName);
  const family = nameSimilarity(incoming.familyName, candidate.familyName);
  const nameScore = given * 0.4 + family * 0.6;
  if (nameScore > 0.8) reasons.push('similar name');

  let score = nameScore * 0.5;

  if (incoming.dateOfBirth && candidate.dateOfBirth) {
    if (incoming.dateOfBirth === candidate.dateOfBirth) {
      score += 0.3;
      reasons.push('same date of birth');
    } else {
      score -= 0.1;
    }
  }

  const ip = digits(incoming.phone);
  const cp = digits(candidate.phone);
  if (ip && cp && ip === cp) {
    score += 0.25;
    reasons.push('same phone');
  }

  if (incoming.sex && candidate.sex && incoming.sex === candidate.sex) {
    score += 0.05;
  } else if (incoming.sex && candidate.sex && incoming.sex !== candidate.sex) {
    score -= 0.05;
  }

  return { candidate, score: Math.max(0, Math.min(1, score)), reasons };
}

/**
 * Return likely duplicates at or above `threshold`, highest score first. The
 * caller shows these for human review — it must not auto-merge (PAT-003/008).
 */
export function findDuplicates(
  incoming: Omit<PatientCandidate, 'id'>,
  candidates: readonly PatientCandidate[],
  threshold = 0.7,
): readonly MatchResult[] {
  return candidates
    .map((c) => scoreCandidate(incoming, c))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
