export {
  detectRepository,
  estimateFromTree,
  hasGeneratedHeader,
  type DetectInput,
  type DetectedFile,
  type Detection,
  type FileEntry,
  type LanguageStat,
  type TreeEstimate,
} from "./detect.ts";
export { detectDocsSources, type DocsSource, type DocsSourceKind } from "./docs.ts";
export { classifyPath, generatedMatcherFromGitattributes, type ClassifiedPath } from "./kinds.ts";
export { CODE_LANGUAGES, detectLanguage } from "./languages.ts";
export { classifyLicenseText, normalizeLicenseField } from "./licenses.ts";
export { detectModules, moduleForPath, type DetectedModule, type ReadText } from "./modules.ts";
