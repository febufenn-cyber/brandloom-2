import type { QualityFlag } from './types';

const AI_CLICHES = [
  'elevate your', 'unlock the power', 'transform your journey', 'game-changer',
  "today's fast-paced world", 'look no further', "we've got you covered",
  'say goodbye to', 'embrace the future', 'more than just',
];

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function containsApproximate(haystack: string[], needle: string) {
  const n = normalize(needle);
  return haystack.some((item) => {
    const h = normalize(item);
    return h.includes(n) || n.includes(h);
  });
}

export function validateDraft(input: {
  hook: string;
  caption: string;
  factsUsed: string[];
  approvedFacts: string[];
  prohibitedPhrases: string[];
  otherHooks?: string[];
}): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const combined = `${input.hook}\n${input.caption}`.toLowerCase();

  for (const phrase of input.prohibitedPhrases) {
    if (phrase.trim() && combined.includes(phrase.toLowerCase())) {
      flags.push({ code: 'prohibited_phrase', severity: 'error', message: `Uses prohibited phrase: ${phrase}`, evidence: phrase });
    }
  }

  for (const phrase of AI_CLICHES) {
    if (combined.includes(phrase)) {
      flags.push({ code: 'ai_cliche', severity: 'warning', message: `Generic AI-style phrase detected: ${phrase}`, evidence: phrase });
    }
  }

  for (const fact of input.factsUsed) {
    if (!containsApproximate(input.approvedFacts, fact)) {
      flags.push({ code: 'unsupported_claim', severity: 'error', message: `Fact is not in the approved fact set: ${fact}`, evidence: fact });
    }
  }

  const normalizedHook = normalize(input.hook);
  if ((input.otherHooks ?? []).some((hook) => normalize(hook) === normalizedHook)) {
    flags.push({ code: 'duplicate_hook', severity: 'warning', message: 'This hook duplicates another post in the same plan.' });
  }

  const specificitySignals = input.approvedFacts.some((fact) => {
    const words = normalize(fact).split(' ').filter((word) => word.length > 4);
    return words.some((word) => normalize(input.caption).includes(word));
  });
  if (input.approvedFacts.length > 0 && !specificitySignals) {
    flags.push({ code: 'missing_specificity', severity: 'warning', message: 'Caption does not appear to use concrete approved product details.' });
  }

  return flags;
}
