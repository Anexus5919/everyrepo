// Plain explanations shown to visitors; internal errors and model names never appear here

export function reasonMessage(code: string, repo: string, detail?: string): string {
  switch (code) {
    case "not-found":
      return `There is no public repository at github.com/${repo}. Check the spelling; private repositories cannot be read.`;
    case "private":
      return "This repository is private. EveryRepo only reads public repositories.";
    case "unavailable":
      return "GitHub has made this repository unavailable, so it cannot be read.";
    case "empty":
      return "This repository has no files yet, so there is nothing to explain.";
    case "no-source":
      return "This repository has no source code files to explain. EveryRepo writes wikis from code.";
    case "large":
      return "This is a large repository. Its wiki takes days on the free models EveryRepo uses, so large requests are approved by hand.";
    case "daily-limit":
      return "Today's automatic approvals are used up. The request is saved and will be reviewed.";
    case "queue-full":
      return "The queue is full right now. The request is saved and will be reviewed.";
    case "declined":
      return "This request was declined.";
    case "allowance":
      return "Waiting for the free model allowance to refill. It carries on by itself.";
    case "retry":
      return "A step ran into a problem and will be tried again shortly.";
    case "failed":
      return detail
        ? `Building this wiki stopped while ${detail.toLowerCase()}. It will be looked into.`
        : "Building this wiki stopped. It will be looked into.";
    default:
      return "";
  }
}
