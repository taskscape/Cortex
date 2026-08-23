import type { RagV2LanguageResult } from './types.js';

const LANGUAGE_MARKERS: Record<string, readonly string[]> = {
  pl: [' oraz ', ' jest ', ' nie ', ' przez ', ' umow', ' wykonawc', ' zamawiaj', ' zgodnie ', ' który', ' która', ' będzie '],
  en: [' and ', ' is ', ' not ', ' shall ', ' agreement ', ' contractor ', ' pursuant ', ' which ', ' with ', ' from '],
  de: [' und ', ' ist ', ' nicht ', ' vertrag ', ' auftrag', ' gemäß ', ' wird ', ' welche', ' durch ', ' mit '],
  fr: [' et ', ' est ', ' pas ', ' contrat ', ' conformément ', ' sera ', ' avec ', ' pour ', ' dans ', ' laquelle '],
  es: [' y ', ' es ', ' no ', ' contrato ', ' conforme ', ' será ', ' con ', ' para ', ' que ', ' por '],
};

function scriptFor(text: string): string {
  if (/[\u0400-\u04ff]/u.test(text)) return 'Cyrillic';
  if (/[\u0370-\u03ff]/u.test(text)) return 'Greek';
  if (/[\u0600-\u06ff]/u.test(text)) return 'Arabic';
  if (/[\u4e00-\u9fff]/u.test(text)) return 'Han';
  if (/[\u3040-\u30ff]/u.test(text)) return 'Japanese';
  if (/[\uac00-\ud7af]/u.test(text)) return 'Hangul';
  if (/[A-Za-zÀ-ž]/u.test(text)) return 'Latin';
  return 'Unknown';
}

/**
 * Detects the dominant language, script, and mixing of a text span.
 * @param text - Text to analyse.
 * @returns Language distribution with primary language and confidence.
 */
export function detectPassageLanguage(text: string): RagV2LanguageResult {
  const normalized = ` ${text.toLocaleLowerCase().replace(/\s+/gu, ' ')} `;
  const scores: Record<string, number> = {};
  for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
    scores[language] = markers.reduce(
      (score, marker) => score + (normalized.includes(marker) ? Math.max(1, marker.trim().length / 4) : 0),
      0,
    );
  }
  if (/[ąćęłńóśźż]/iu.test(text)) scores['pl'] = (scores['pl'] ?? 0) + 5;
  if (/[äöüß]/iu.test(text)) scores['de'] = (scores['de'] ?? 0) + 4;
  if (/[àâçéèêëîïôûùüÿœ]/iu.test(text)) scores['fr'] = (scores['fr'] ?? 0) + 3;
  if (/[áéíñóúü¿¡]/iu.test(text)) scores['es'] = (scores['es'] ?? 0) + 3;

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const best = ranked[0];
  const confidence = best && total > 0 ? best[1] / total : 0;
  const distribution = total > 0
    ? Object.fromEntries(ranked.filter(([, score]) => score > 0).map(([language, score]) => [language, score / total]))
    : {};
  return {
    primary: best && best[1] >= 2 && confidence >= 0.45 ? best[0]! : 'und',
    confidence,
    distribution,
    mixed: ranked.filter(([, score]) => score / Math.max(total, 1) >= 0.2).length > 1,
    script: scriptFor(text),
  };
}

