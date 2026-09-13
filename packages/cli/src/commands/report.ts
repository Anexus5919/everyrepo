import { formatRepoRef, parseRepoRef, repoDirName } from "@everyrepo/core";
import { engineDbPath, findRepo } from "@everyrepo/db";
import { buildReport, type SnapshotReport } from "@everyrepo/pipeline";
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
  if (report.imports.length > 0) {
    lines.push("");
    lines.push("Imports by language");
    const byLanguage = new Map<string, Record<string, number>>();
    for (const row of report.imports) {
      const counts = byLanguage.get(row.language) ?? {};
      counts[row.resolution] = row.count;
      byLanguage.set(row.language, counts);
    }
    for (const [language, counts] of byLanguage) {
      const internal = (counts["resolved"] ?? 0) + (counts["unresolved"] ?? 0);
      const rate = internal > 0 ? Math.round((100 * (counts["resolved"] ?? 0)) / internal) : 100;
      lines.push(
        `  ${language.padEnd(12)} ${number(counts["resolved"] ?? 0).padStart(7)} resolved ${number(counts["unresolved"] ?? 0).padStart(6)} unresolved ${number(counts["external"] ?? 0).padStart(7)} external  ${rate}% of internal`,
      );
    }
    lines.push(
      `Edges: ${report.edges.map((row) => `${row.kind} ${number(row.count)}`).join(", ")}`,
    );
    lines.push("");
    lines.push("Most central source files");
    for (const file of report.topRankedFiles) {
      lines.push(`  ${file.score.toFixed(4)}  ${file.path}`);
    }
    lines.push("");
    lines.push(`Clusters: ${report.clusterCount} (largest by tokens)`);
    for (const cluster of report.largestClusters) {
      lines.push(
        `  ${cluster.label.padEnd(56)} ${String(cluster.files).padStart(5)} files ${number(cluster.tokens).padStart(9)} tokens`,
      );
    }
  }
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
            `${formatRepoRef(ref)} has not been indexed yet. Run: pnpm everyrepo index ${formatRepoRef(ref)}`,
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
