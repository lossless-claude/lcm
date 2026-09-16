import type { LcmPaths } from "../lcm-paths.js";
import { readProjectMeta } from "../daemon/project-meta.js";
import { primarySubtag } from "../store/language-pack.js";

/**
 * The two languages a caller needs to know before it searches: the one the
 * project's author writes in (detected once at ingest, recorded in the
 * project's meta.json) and the pivot language a query is translated into when
 * they differ.
 *
 * The pivot is a setting, not a measurement: it names the language `pivotQuery`
 * is expected to be written in, not a language detected in the corpus.
 */
export type PivotLanguages = { authorLanguage?: string; pivotLanguage: string };

/** The language recorded for this project, or undefined while none has been detected. */
export function projectAuthorLanguage(cwd: string, paths: LcmPaths): string | undefined {
  const language = readProjectMeta(cwd, paths)?.language;
  return typeof language === "string" && language.length > 0 ? language : undefined;
}

export function pivotLanguagesFor(cwd: string, pivotLanguage: string, paths: LcmPaths): PivotLanguages {
  return { authorLanguage: projectAuthorLanguage(cwd, paths), pivotLanguage };
}

/** True when a translated query would search in a different language than the author writes. */
export function pivotQueryApplies(languages: PivotLanguages): boolean {
  return (
    languages.authorLanguage !== undefined &&
    primarySubtag(languages.authorLanguage) !== primarySubtag(languages.pivotLanguage)
  );
}

/**
 * The one line a caller is told before its first search, so it does not have to
 * discover the mismatch from an empty result.
 */
export function pivotQueryHint(languages: PivotLanguages): string | undefined {
  if (!pivotQueryApplies(languages)) return undefined;
  return `This project's author writes ${languages.authorLanguage}; much of what answers a query is ${languages.pivotLanguage}. Pass lcm_search a pivotQuery holding your query translated to ${languages.pivotLanguage} — it is added to the original, not a replacement for it.`;
}
