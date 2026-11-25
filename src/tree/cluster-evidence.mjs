import { digest, fail } from './contracts.mjs';

export const CLUSTER_EVIDENCE = 'CLUSTER_EVIDENCE';
const minimumEpisodes = 3;

export function requireClusterReactions(episodes, refs) {
  const supplied = new Set(refs.map(digest)), reactions = new Map(), matched = new Map();
  for (const episode of episodes) {
    const candidates = reactions.get(episode.id) ?? new Set();
    for (const ref of episode.reactionRefs) {
      const key = digest(ref);
      if (supplied.has(key)) candidates.add(key);
    }
    reactions.set(episode.id, candidates);
  }
  // Each counted episode needs a different original reaction. If two
  // episodes share a reaction, reassign it only if its old episode has another.
  function match(id, seen) {
    for (const key of reactions.get(id)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matched.has(key) || match(matched.get(key), seen)) {
        matched.set(key, id); return true;
      }
    }
    return false;
  }
  for (const id of reactions.keys()) if (match(id, new Set()) && matched.size >= minimumEpisodes) return;
  fail(CLUSTER_EVIDENCE, 'Diagnosis needs separate original reactions from three distinct episodes');
}
