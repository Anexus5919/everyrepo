import { formatRepoRef, parseRepoRef, repoDirName } from "@kickstart/core";
import { engineDbPath, findRepo } from "@kickstart/db";
import { buildReport, type SnapshotReport } from "@kickstart/pipeline";
import { Command } from "commander";
import { openContext } from "../context.ts";

const number = (value: number) => value.toLocaleString("en-US");
const millions = (value: number) => `${(value / 1e6).toFixed(2)}M`;

function printReport(report: SnapshotReport): void {
  const lines: string[] = [];
  lines.push(`${report.repo} at ${report.ref} (${report.sha.slice(0, 10)})`);
  lines.push(`Size tier ${report.sizeTier ?? "?"}, ${number(report.sourceTokens)} source tokens`);
  lines.push("");
  lines.push("Files by kind");
  const kinds = Object.entries(report.kinds).sort((a, b) => b[1] - a[1]);
  lines.push(`  ${kinds.map(([kind, count]) => `${kind} ${number(count)}`).join(", ")}`);
  lines.push("");
  lines.push("Languages (source and type files)");
  for (const language of report.languages.slice(0, 8)) {
    lines.push(
      `  ${language.language.padEnd(12)} ${number(language.files).padStart(7)} files ${number(language.tokens).padStart(11)} tokens`,
    );
  }
  lines.push("");
  lines.push(`Modules: ${report.moduleCount} (largest by source tokens)`);
  for (const module of report.topModules) {
    const path = module.path || "(root)";
    lines.push(
      `  ${path.padEnd(44)} ${module.kind.padEnd(10)} ${String(module.license ?? "-").padEnd(12)} ${number(module.sourceTokens).padStart(10)} tokens`,
    );
  }
  lines.push(
    `Licenses: ${report.licenses.map((row) => `${row.license} ${row.modules}`).join(", ")}`,
  );
  lines.push(
    `Docs sources: ${report.docsSources.length > 0 ? report.docsSources.map((source) => `${source.kind} at ${source.path || "(root)"}`).join(", ") : "none detected"}`,
  );
  lines.push("");
  const parse = report.parse;
  lines.push(
    `Parsing: ${number(parse["ok"] ?? 0)} ok, ${number(parse["partial"] ?? 0)} with syntax errors, ${number(parse["failed"] ?? 0)} failed, ${number(parse["skipped"] ?? 0)} not parsed`,
  );
  lines.push(
    `Symbols: ${number(report.definitions)} definitions (${number(report.exportedDefinitions)} exported), ${number(report.references)} references`,
  );
  lines.push(
    `  kinds: ${report.definitionKinds.map((row) => `${row.kind} ${number(row.count)}`).join(", ")}`,
  );
  lines.push(
    `  most referenced: ${report.mostReferenced.map((row) => `${row.name} (${number(row.references)})`).join(", ")}`,
  );
  if (report.estimate) {
    const estimate = report.estimate;
    lines.push("");
    lines.push(
      `Estimated first index: ${millions(estimate.inputTokens)} input, ${millions(estimate.outputTokens)} output tokens; ${millions(estimate.localTokens)} local, ${millions(estimate.cloudTokens)} cloud; ${estimate.pages} pages`,
    );
  }
  console.log(lines.join("\n"));
}

export function reportCommand(): Command {
  return new Command("report")
    .description("Summarize the latest indexed snapshot of a repository")
    .argument("<repo>", "owner/name or GitHub URL")
    .option("--json", "print the report as JSON")
    .action(async (repoArg: string, options: { json?: boolean }) => {
      const ref = parseRepoRef(repoArg);
      const context = await openContext();
      try {
        const repo = findRepo(context.appDb, ref);
        if (!repo?.lastIndexedSha) {
          throw new Error(
            `${formatRepoRef(ref)} has not been indexed yet. Run: pnpm kickstart index ${formatRepoRef(ref)}`,
          );
        }
        const report = buildReport(
          engineDbPath(context.config.dataDir, repoDirName(ref), repo.lastIndexedSha),
        );
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else printReport(report);
      } finally {
        context.close();
      }
    });
}
