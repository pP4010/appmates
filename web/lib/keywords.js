/**
 * Keyword field engine — the browser counterpart of
 * `core/services/keyword_builder.KeywordBuilder`.
 *
 * Entirely deterministic: no network, no clock, no filesystem. Given the same
 * title, subtitle, field and targets it returns exactly what the CLI returns,
 * and `test/conformance.test.js` proves it against a corpus generated from the
 * Python implementation.
 *
 * Every rule follows from one documented Apple behaviour: the app name, the
 * subtitle and the 100-character keyword field are indexed as a single pool of
 * *words*, and matches are formed by combining them.
 */

export const Severity = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

let ASO = null;

export function loadAso(spec) {
  ASO = spec.aso ?? spec;
  // Sets make the membership tests O(1) and keep this readable.
  ASO.noiseSet = new Set(ASO.noise_words);
  ASO.categorySet = new Set(ASO.category_words);
  ASO.trademarkSet = new Set(ASO.trademark_words);
}

export function getAso() {
  if (!ASO) throw new Error('loadAso() must be called before auditing');
  return ASO;
}

/**
 * Split into indexable words, lowercased, punctuation removed.
 *
 * `\p{L}\p{N}` rather than `\w`: JavaScript's `\w` is ASCII-only, so it would
 * split "café" into "caf" and "é" where Python's re.UNICODE keeps it whole.
 * Accents are preserved rather than folded — "café" and "cafe" are different
 * search terms on a French storefront, and folding them would claim coverage
 * the listing does not have.
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

export function splitField(fieldValue) {
  return (fieldValue ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function looksPlural(word, other) {
  return word === `${other}s` || word === `${other}es`;
}

function severityFor(code) {
  return getAso().findings?.[code] ?? Severity.WARNING;
}

function finding(code, message, { fixHint = null, cost = 0, word = null, phrase = null } = {}) {
  const metadata = {};
  if (word) metadata.word = word;
  if (phrase) metadata.phrase = phrase;
  if (cost) metadata.cost = cost;
  return {
    code,
    severity: severityFor(code),
    message,
    store: 'apple',
    fixHint,
    fixable: true,
    metadata,
  };
}

/** Which target phrases the listing can actually rank for. */
export function checkCoverage(targets, { title = '', subtitle = '', field = '' } = {}) {
  const sources = {
    title: new Set(tokenize(title)),
    subtitle: new Set(tokenize(subtitle)),
    keywords: new Set(splitField(field).flatMap((term) => tokenize(term))),
  };
  const pool = new Set([...sources.title, ...sources.subtitle, ...sources.keywords]);

  return targets.map((phrase) => {
    const words = tokenize(phrase);
    const missing = words.filter((w) => !pool.has(w));
    const coveredBy = {};
    for (const [name, set] of Object.entries(sources)) {
      const hits = words.filter((w) => set.has(w));
      if (hits.length) coveredBy[name] = hits;
    }
    return {
      phrase,
      covered: words.length > 0 && missing.length === 0,
      missingWords: missing,
      coveredBy,
    };
  });
}

/**
 * Construct the field covering `targets` in the fewest characters.
 *
 * Words already in the title or subtitle are dropped — they are already in the
 * pool. Words are emitted in target order, so when the budget runs out the
 * phrases listed first survive.
 */
export function buildField(targets, { title = '', subtitle = '', extra = [] } = {}) {
  const aso = getAso();
  const indexed = new Set([...tokenize(title), ...tokenize(subtitle)]);
  const skip = (w) => indexed.has(w) || aso.noiseSet.has(w) || aso.categorySet.has(w);

  const ordered = [];
  for (const phrase of targets) {
    for (const word of tokenize(phrase)) {
      if (!skip(word) && !ordered.includes(word)) ordered.push(word);
    }
  }
  for (const word of extra) {
    if (!skip(word) && !ordered.includes(word)) ordered.push(word);
  }

  const chosen = [];
  let length = 0;
  for (const word of ordered) {
    const cost = word.length + (chosen.length ? 1 : 0);
    if (length + cost > aso.field.max_length) continue; // a shorter later word may fit
    chosen.push(word);
    length += cost;
  }
  return chosen.join(aso.field.separator);
}

/**
 * Characters reclaimable by fixing the findings.
 *
 * Deduplicated per word, taking the largest cost attributed to each: one word
 * commonly trips several rules at once, but deleting it reclaims its characters
 * once, not once per rule.
 */
export function wastedCharacters(findings) {
  const perWord = new Map();
  let loose = 0;
  for (const f of findings) {
    const cost = f.metadata?.cost ?? 0;
    if (!cost) continue;
    const word = f.metadata?.word;
    if (word) perWord.set(word, Math.max(perWord.get(word) ?? 0, cost));
    else loose += cost;
  }
  return [...perWord.values()].reduce((a, b) => a + b, 0) + loose;
}

/** Report everything wrong with a keyword field, with the cost of each. */
export function auditField(fieldValue, { title = '', subtitle = '', targets = [] } = {}) {
  const aso = getAso();
  const terms = splitField(fieldValue);
  const titleWords = new Set(tokenize(title));
  const subtitleWords = new Set(tokenize(subtitle));
  const alreadyIndexed = new Set([...titleWords, ...subtitleWords]);

  const findings = [];

  if (fieldValue.length > aso.field.max_length) {
    findings.push(
      finding(
        'ASO_KEYWORD_FIELD_TOO_LONG',
        `Keyword field is ${fieldValue.length} characters, over the ${aso.field.max_length} limit.`,
        { fixHint: `Remove ${fieldValue.length - aso.field.max_length} character(s).` },
      ),
    );
  }

  const spaceCount = (fieldValue.match(/ /g) ?? []).length;
  if (spaceCount) {
    findings.push(
      finding('ASO_KEYWORD_SPACES', `${spaceCount} space(s) in the keyword field.`, {
        fixHint: "Separate with commas only: 'a,b,c' not 'a, b, c'.",
        cost: spaceCount,
      }),
    );
  }

  // Insertion order matters: it is what makes the finding list match Python's,
  // which iterates a dict built the same way.
  const seen = new Map();
  for (const term of terms) {
    for (const word of tokenize(term)) {
      seen.set(word, (seen.get(word) ?? 0) + 1);
    }
  }

  for (const [word, count] of seen) {
    if (count > 1) {
      findings.push(
        finding('ASO_DUPLICATE_IN_FIELD', `'${word}' appears ${count} times in the keyword field.`, {
          fixHint: 'Apple indexes each word once; keep a single occurrence.',
          cost: (count - 1) * (word.length + 1),
          word,
        }),
      );
    }
    if (alreadyIndexed.has(word)) {
      const source = titleWords.has(word) ? 'title' : 'subtitle';
      findings.push(
        finding(
          'ASO_DUPLICATE_OF_TITLE',
          `'${word}' is already in the ${source}, so it is already indexed.`,
          {
            fixHint: `Remove '${word}' and spend the characters on a new term.`,
            cost: word.length + 1,
            word,
          },
        ),
      );
    }
    if (aso.noiseSet.has(word)) {
      findings.push(
        finding('ASO_NOISE_WORD', `'${word}' carries no search intent.`, {
          fixHint: 'Nobody searches this word alone; the characters are better spent.',
          cost: word.length + 1,
          word,
        }),
      );
    }
    if (aso.categorySet.has(word)) {
      findings.push(
        finding(
          'ASO_CATEGORY_WORD',
          `'${word}' is a category name and is already indexed from your category.`,
          { fixHint: `Remove '${word}'.`, cost: word.length + 1, word },
        ),
      );
    }
    if (aso.trademarkSet.has(word)) {
      findings.push(
        finding('ASO_TRADEMARK_RISK', `'${word}' looks like another company's trademark.`, {
          fixHint:
            'Naming a competitor in metadata risks rejection under App Review Guideline 5.2.1.',
          word,
        }),
      );
    }
  }

  const words = [...seen.keys()];
  for (const word of words) {
    for (const other of words) {
      if (word !== other && looksPlural(word, other)) {
        findings.push(
          finding('ASO_PLURAL_PAIR', `'${word}' and '${other}' differ only by pluralisation.`, {
            fixHint:
              'Apple stems some plurals but has never documented which. Keeping both is usually spend for nothing.',
            cost: word.length + 1,
            word,
          }),
        );
      }
    }
  }

  const coverage = checkCoverage(targets, { title, subtitle, field: fieldValue });
  for (const item of coverage) {
    if (!item.covered) {
      findings.push(
        finding(
          'ASO_UNCOVERED_TARGET',
          `'${item.phrase}' is not reachable: missing ${item.missingWords.join(', ')}.`,
          {
            fixHint: `Add ${item.missingWords.join(', ')} to the keyword field.`,
            phrase: item.phrase,
          },
        ),
      );
    }
  }

  const indexedWords = [...new Set([...alreadyIndexed, ...seen.keys()])].sort();
  const rebuilt = buildField(targets.length ? targets : terms, {
    title,
    subtitle,
    extra: [...seen.keys()].filter((w) => !alreadyIndexed.has(w)),
  });

  return {
    fieldValue,
    maxLength: aso.field.max_length,
    title,
    subtitle,
    length: fieldValue.length,
    remaining: aso.field.max_length - fieldValue.length,
    indexedWords,
    findings,
    coverage,
    wastedCharacters: wastedCharacters(findings),
    uncoveredTargets: coverage.filter((c) => !c.covered).map((c) => c.phrase),
    suggestedField: rebuilt !== fieldValue ? rebuilt : null,
  };
}
