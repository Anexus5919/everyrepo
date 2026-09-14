// Generated prose follows the same writing rules as the rest of the product: no long dashes, no emoji
export function plainText(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\u{FE0F}/gu, "")
    .replace(/ {2,}/g, " ")
    .replace(/ ,/g, ",")
    .trim();
}
