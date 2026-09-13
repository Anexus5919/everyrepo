import { describe, expect, it } from "vitest";
import { clusterFiles } from "./cluster.ts";
import { cochangeEdges, COMMIT_MARKER, parseNameOnlyLog } from "./cochange.ts";
import { parseJsonc } from "./jsonc.ts";
import { rankFiles } from "./rank.ts";
import { referenceEdges } from "./references.ts";
import { createImportResolver, pickExport } from "./resolve/index.ts";
import type { GraphFile, GraphImport, GraphModule } from "./types.ts";

let nextId = 1;
function file(path: string, extra: Partial<GraphFile> = {}): GraphFile {
  const language = path.endsWith(".java")
    ? "java"
    : path.endsWith(".py")
      ? "python"
      : path.endsWith(".go")
        ? "go"
        : path.endsWith(".rs")
          ? "rust"
          : path.endsWith(".tsx")
            ? "tsx"
            : path.endsWith(".js")
              ? "javascript"
              : "typescript";
  return { id: nextId++, path, kind: "src", language, modulePath: "", tokens: 100, ...extra };
}

function ref(specifier: string, kind = "import", names?: string[]): GraphImport {
  return { id: 0, fileId: 0, specifier, kind, ...(names ? { names } : {}) };
}

describe("JavaScript and TypeScript resolution", () => {
  const files = [
    file("packages/grid/src/index.ts"),
    file("packages/grid/src/hooks/useGrid.ts"),
    file("packages/grid/src/internals/index.ts"),
    file("packages/grid/src/components/Cell.tsx"),
    file("packages/pro/src/index.ts"),
    file("packages/utils/lib/format.js"),
    file("tools/alias/target.ts"),
  ];
  const resolve = createImportResolver({
    files,
    modules: [],
    aliases: [{ pattern: "@alias/*", targets: ["tools/alias/*"] }],
    packages: [
      {
        name: "@acme/grid",
        path: "packages/grid",
        exports: {
          ".": { types: "./build/index.d.ts" },
          "./internals": "./build/internals/index.js",
        },
      },
      { name: "@acme/pro", path: "packages/pro" },
      { name: "utils", path: "packages/utils", exports: { "./*": "./lib/*.js" } },
    ],
    pythonRoots: [],
  });
  const from = files[3]!;

  it.each([
    ["../hooks/useGrid.js", "packages/grid/src/hooks/useGrid.ts"],
    ["../internals", "packages/grid/src/internals/index.ts"],
    ["@acme/grid", "packages/grid/src/index.ts"],
    ["@acme/grid/internals", "packages/grid/src/internals/index.ts"],
    ["@acme/pro", "packages/pro/src/index.ts"],
    ["utils/format", "packages/utils/lib/format.js"],
    ["@alias/target", "tools/alias/target.ts"],
  ])("resolves %s", (specifier, target) => {
    expect(resolve(from, ref(specifier))).toEqual({ resolution: "resolved", targets: [target] });
  });

  it("separates external packages from broken relative imports", () => {
    expect(resolve(from, ref("react")).resolution).toBe("external");
    expect(resolve(from, ref("@mui/material/Button")).resolution).toBe("external");
    expect(resolve(from, ref("./Missing")).resolution).toBe("unresolved");
  });

  it("reads conditional and pattern exports", () => {
    expect(pickExport({ import: "./esm/index.js", require: "./cjs/index.js" }, ".")).toBe(
      "./esm/index.js",
    );
    expect(pickExport({ "./*": { default: "./dist/*.mjs" } }, "./a/b")).toBe("./dist/a/b.mjs");
    expect(pickExport("./main.js", "./sub")).toBeUndefined();
  });
});

describe("Java, Python, Go and Rust resolution", () => {
  it("resolves Java classes, nested classes, wildcards and static imports", () => {
    const job = file("core/src/main/java/hudson/model/Job.java", { packageName: "hudson.model" });
    const run = file("core/src/main/java/hudson/model/Run.java", { packageName: "hudson.model" });
    const util = file("core/src/main/java/hudson/util/Timer.java", { packageName: "hudson.util" });
    const resolve = createImportResolver({
      files: [job, run, util],
      modules: [],
      aliases: [],
      packages: [],
      pythonRoots: [],
    });
    expect(resolve(job, ref("hudson.util.Timer")).targets).toEqual([util.path]);
    expect(resolve(job, ref("hudson.util.Timer.Task")).targets).toEqual([util.path]);
    expect(resolve(util, ref("hudson.model", "wildcard")).targets).toEqual([job.path, run.path]);
    expect(resolve(job, ref("hudson.util.Timer.get", "static")).targets).toEqual([util.path]);
    expect(resolve(job, ref("java.util.List")).resolution).toBe("external");
    expect(resolve(job, ref("hudson.missing.Thing")).resolution).toBe("unresolved");
  });

  it("resolves Python absolute, relative and submodule imports", () => {
    const main = file("src/app/main.py");
    const files = [
      main,
      file("src/app/__init__.py"),
      file("src/app/util.py"),
      file("src/app/db/models.py"),
    ];
    const resolve = createImportResolver({
      files,
      modules: [],
      aliases: [],
      packages: [],
      pythonRoots: ["src"],
    });
    expect(resolve(main, ref("app.util")).targets).toEqual(["src/app/util.py"]);
    expect(resolve(main, ref(".util", "from", ["helper"])).targets).toEqual(["src/app/util.py"]);
    expect(resolve(main, ref("app.db", "from", ["models"])).targets).toEqual([
      "src/app/db/models.py",
    ]);
    expect(resolve(main, ref("os.path")).resolution).toBe("external");
  });

  it("resolves Go imports to every non-test file of the package directory", () => {
    const main = file("services/api/cmd/main.go");
    const files = [
      main,
      file("services/api/internal/store/db.go"),
      file("services/api/internal/store/cache.go"),
      file("services/api/internal/store/db_test.go"),
    ];
    const modules: GraphModule[] = [
      { id: 1, name: "github.com/acme/api", path: "services/api", kind: "go" },
    ];
    const resolve = createImportResolver({
      files,
      modules,
      aliases: [],
      packages: [],
      pythonRoots: [],
    });
    expect(resolve(main, ref("github.com/acme/api/internal/store")).targets.sort()).toEqual([
      "services/api/internal/store/cache.go",
      "services/api/internal/store/db.go",
    ]);
    expect(resolve(main, ref("fmt")).resolution).toBe("external");
  });

  it("resolves Rust mod declarations and crate, self, super and workspace crate paths", () => {
    const lib = file("native/src/lib.rs");
    const payment = file("native/src/runtime/payment.rs");
    const files = [
      lib,
      payment,
      file("native/src/runtime/mod.rs"),
      file("native/src/runtime/payment/tx.rs"),
      file("common/src/lib.rs"),
      file("common/src/hash.rs"),
    ];
    const modules: GraphModule[] = [
      { id: 1, name: "affine_native", path: "native", kind: "cargo" },
      { id: 2, name: "affine-common", path: "common", kind: "cargo" },
    ];
    const resolve = createImportResolver({
      files,
      modules,
      aliases: [],
      packages: [],
      pythonRoots: [],
    });
    expect(resolve(lib, ref("runtime", "mod")).targets).toEqual(["native/src/runtime/mod.rs"]);
    expect(resolve(payment, ref("tx", "mod")).targets).toEqual([
      "native/src/runtime/payment/tx.rs",
    ]);
    expect(resolve(lib, ref("crate::runtime::payment::Payment", "use")).targets).toEqual([
      payment.path,
    ]);
    expect(resolve(payment, ref("self::tx::Tx", "use")).targets).toEqual([
      "native/src/runtime/payment/tx.rs",
    ]);
    expect(resolve(payment, ref("super::mod_helper", "use")).targets).toEqual([
      "native/src/runtime/mod.rs",
    ]);
    expect(resolve(payment, ref("affine_common::hash::sha", "use")).targets).toEqual([
      "common/src/hash.rs",
    ]);
    expect(resolve(payment, ref("std::sync::Arc", "use")).resolution).toBe("external");
  });
});

describe("graph signals", () => {
  it("weights distinctive names and damps names defined in many files", () => {
    const edges = referenceEdges(
      [
        { fileId: 1, name: "useGridApiRef" },
        ...[2, 3, 4, 5, 6, 7].map((fileId) => ({ fileId, name: "render" })),
      ],
      [
        { fileId: 9, name: "useGridApiRef", count: 4 },
        { fileId: 9, name: "render", count: 1 },
        { fileId: 1, name: "useGridApiRef", count: 3 },
      ],
    );
    const toFile1 = edges.find((edge) => edge.src === 9 && edge.dst === 1);
    const toFile2 = edges.find((edge) => edge.src === 9 && edge.dst === 2);
    expect(toFile1?.weight).toBeCloseTo(20);
    expect(toFile2?.weight).toBeCloseTo(0.1);
    expect(edges.some((edge) => edge.src === 1 && edge.dst === 1)).toBe(false);
  });

  it("links files that change together often", () => {
    const log = [
      COMMIT_MARKER,
      "",
      "a.ts",
      "src/commit.ts",
      "",
      COMMIT_MARKER,
      "",
      "a.ts",
      "src/commit.ts",
      "c.ts",
      "",
      COMMIT_MARKER,
      "",
      "c.ts",
      "",
    ].join("\n");
    const commits = parseNameOnlyLog(log);
    expect(commits).toEqual([
      ["a.ts", "src/commit.ts"],
      ["a.ts", "src/commit.ts", "c.ts"],
      ["c.ts"],
    ]);
    const ids = new Map([
      ["a.ts", 1],
      ["src/commit.ts", 2],
      ["c.ts", 3],
    ]);
    const edges = cochangeEdges(commits, ids);
    expect(edges).toEqual([{ src: 1, dst: 2, weight: 1 }]);
  });

  it("ranks the most depended-on file highest", () => {
    const scores = rankFiles(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 4, weight: 1 },
        { src: 2, dst: 4, weight: 1 },
        { src: 3, dst: 4, weight: 1 },
        { src: 4, dst: 1, weight: 0.1 },
      ],
    );
    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(best).toBe(4);
  });

  it("keeps small modules whole and splits large modules into connected groups", () => {
    const modules: GraphModule[] = [
      { id: 1, name: "root", path: "", kind: "repository" },
      { id: 2, name: "grid", path: "grid", kind: "npm" },
    ];
    const small = [file("README.ts", { modulePath: "" })];
    const left = Array.from({ length: 6 }, (_, index) =>
      file(`grid/filter/f${index}.ts`, { modulePath: "grid", tokens: 4000 }),
    );
    const right = Array.from({ length: 6 }, (_, index) =>
      file(`grid/sort/s${index}.ts`, { modulePath: "grid", tokens: 4000 }),
    );
    const chain = (group: GraphFile[]) =>
      group.slice(1).map((f, index) => ({ src: group[index]!.id, dst: f.id, weight: 5 }));
    const edges = { imports: [...chain(left), ...chain(right)], references: [], cochanges: [] };
    const scores = new Map([[left[0]!.id, 1]]);

    const clusters = clusterFiles([...small, ...left, ...right], modules, edges, scores);
    expect(clusters.map((cluster) => [cluster.key, cluster.label, cluster.fileIds.length])).toEqual(
      [
        ["(root)#1", "(root)", 1],
        ["grid#1", "grid/filter", 6],
        ["grid#2", "grid/sort", 6],
      ],
    );
    expect(clusters[1]?.topFiles[0]).toBe(left[0]!.path);
    expect(clusterFiles([...small, ...left, ...right], modules, edges, scores)).toEqual(clusters);
  });
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas without breaking strings", () => {
    const text = `{
      // line comment
      "compilerOptions": { "baseUrl": ".", /* block */ "paths": { "@x/*": ["./src/*"], }, },
      "url": "https://example.com/a//b",
    }`;
    expect(parseJsonc(text)).toEqual({
      compilerOptions: { baseUrl: ".", paths: { "@x/*": ["./src/*"] } },
      url: "https://example.com/a//b",
    });
  });
});
