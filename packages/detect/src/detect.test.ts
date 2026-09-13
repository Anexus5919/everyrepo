import { describe, expect, it } from "vitest";
import { detectRepository, type FileEntry } from "./detect.ts";
import { detectDocsSources } from "./docs.ts";
import { classifyPath, generatedMatcherFromGitattributes } from "./kinds.ts";
import { classifyLicenseText, normalizeLicenseField } from "./licenses.ts";

const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person";
const COMMERCIAL =
  "Commercial License\n\nThis software is commercial. You must agree to the End User License Agreement.";

function fixture(files: Record<string, string>) {
  const entries: FileEntry[] = Object.entries(files).map(([path, content], index) => ({
    path,
    oid: String(index),
    bytes: Buffer.byteLength(content),
  }));
  const readText = async (path: string) => files[path];
  return { entries, readText };
}

describe("classifyPath", () => {
  it.each([
    ["packages/x-data-grid/src/DataGrid.tsx", "src", "tsx"],
    ["packages/x-data-grid/src/index.d.ts", "types", "typescript"],
    ["packages/x-data-grid/src/DataGrid.test.tsx", "test", "tsx"],
    ["core/src/test/java/hudson/model/JobTest.java", "test", "java"],
    ["core/src/main/java/hudson/model/Job.java", "src", "java"],
    ["core/src/main/java/hudson/model/JobIT.java", "test", "java"],
    ["pkg/server/handler_test.go", "test", "go"],
    ["docs/data/data-grid/filtering/Basic.tsx", "docs", "tsx"],
    ["README.md", "docs", "markdown"],
    ["node_modules/react/index.js", "vendored", "javascript"],
    ["assets/app.min.js", "vendored", "javascript"],
    ["pnpm-lock.yaml", "generated", "yaml"],
    ["packages/core/dist/index.js", "generated", "javascript"],
    ["src/__snapshots__/view.test.ts.snap", "generated", undefined],
    ["public/logo.png", "asset", undefined],
    ["examples/next-app/src/page.tsx", "example", "tsx"],
    ["packages/x-data-grid/src/locales/frFR.ts", "locale", "typescript"],
    ["po/fr.po", "locale", "gettext"],
    [".github/workflows/ci.yml", "config", "yaml"],
    ["package.json", "config", "json"],
    ["vite.config.ts", "config", "typescript"],
    ["crates/core/src/lib.rs", "src", "rust"],
    ["core/src/main/resources/hudson/model/Job/index.jelly", "src", "jelly"],
    ["core/src/main/resources/hudson/model/Messages_de.properties", "locale", "properties"],
    ["core/src/main/resources/hudson/model/Job/index_pt_BR.properties", "locale", "properties"],
    ["core/src/main/resources/hudson/model/Messages.properties", "config", "properties"],
    ["core/src/main/resources/hudson/model/Job/help-name.html", "docs", "html"],
    ["www/apps/book/app/learn/page.tsx", "docs", "tsx"],
    ["www/apps/resources/generated/files-map.mjs", "generated", "javascript"],
    ["LICENSE", "other", undefined],
  ])("%s is %s", (path, kind, language) => {
    const result = classifyPath(path);
    expect(result.kind).toBe(kind);
    expect(result.language).toBe(language);
  });

  it("honors linguist-generated and linguist-vendored attributes", () => {
    const matcher = generatedMatcherFromGitattributes(
      "# comment\nsrc/gen/** linguist-generated=true\n*.pb.ts linguist-generated\n/third/** linguist-vendored\n*.ts text eol=lf\n",
    );
    expect(classifyPath("src/gen/api/client.ts", matcher).kind).toBe("generated");
    expect(classifyPath("packages/a/model.pb.ts", matcher).kind).toBe("generated");
    expect(classifyPath("third/lib/a.ts", matcher).kind).toBe("generated");
    expect(classifyPath("src/app.ts", matcher).kind).toBe("src");
  });
});

describe("licenses", () => {
  it("normalizes manifest license fields", () => {
    expect(normalizeLicenseField("MIT")).toBe("MIT");
    expect(normalizeLicenseField("SEE LICENSE IN LICENSE")).toBeUndefined();
    expect(normalizeLicenseField({ type: "Apache-2.0" })).toBe("Apache-2.0");
    expect(normalizeLicenseField([{ type: "MIT" }, { type: "ISC" }])).toBe("MIT OR ISC");
    expect(normalizeLicenseField({ text: "BSD-3-Clause" })).toBe("BSD-3-Clause");
  });

  it("classifies common license texts", () => {
    expect(classifyLicenseText(MIT)).toBe("MIT");
    expect(classifyLicenseText("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0");
    expect(classifyLicenseText("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3")).toBe("AGPL-3.0");
    expect(classifyLicenseText(COMMERCIAL)).toBe("commercial");
    expect(classifyLicenseText("custom terms")).toBe("unknown");
  });
});

describe("detectRepository", () => {
  it("finds pnpm workspace packages, licenses per package and the deepest module per file", async () => {
    const { entries, readText } = fixture({
      "package.json": JSON.stringify({ name: "monorepo", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - docs\n  - '!packages/ignored'\n",
      LICENSE: MIT,
      "packages/grid/package.json": JSON.stringify({ name: "@acme/grid", license: "MIT" }),
      "packages/grid/src/Grid.tsx": "export function Grid() { return null; }",
      "packages/grid-pro/package.json": JSON.stringify({
        name: "@acme/grid-pro",
        license: "SEE LICENSE IN LICENSE",
      }),
      "packages/grid-pro/LICENSE": COMMERCIAL,
      "packages/grid-pro/src/GridPro.tsx": "export function GridPro() { return null; }",
      "packages/ignored/package.json": JSON.stringify({ name: "ignored" }),
      "docs/package.json": JSON.stringify({ name: "docs" }),
      "examples/app/package.json": JSON.stringify({ name: "example-app" }),
      "scripts/build.ts": "console.log('build')",
    });
    const detection = await detectRepository({ entries, readText, repoName: "monorepo" });

    const modules = Object.fromEntries(detection.modules.map((module) => [module.path, module]));
    expect(Object.keys(modules).sort()).toEqual(["", "docs", "packages/grid", "packages/grid-pro"]);
    expect(modules["packages/grid"]?.license).toBe("MIT");
    expect(modules["packages/grid-pro"]?.license).toBe("commercial");
    expect(modules["docs"]?.license).toBe("MIT");

    const moduleOf = Object.fromEntries(
      detection.files.map((file) => [file.path, file.modulePath]),
    );
    expect(moduleOf["packages/grid-pro/src/GridPro.tsx"]).toBe("packages/grid-pro");
    expect(moduleOf["scripts/build.ts"]).toBe("");
    expect(detection.sizeTier).toBe("S");
    expect(detection.languages[0]?.language).toBe("tsx");
  });

  it("follows Maven module lists recursively", async () => {
    const pom = (artifactId: string, modules: string[] = [], licenses = "") =>
      `<project><artifactId>${artifactId}</artifactId>${licenses}<modules>${modules
        .map((module) => `<module>${module}</module>`)
        .join("")}</modules></project>`;
    const { entries, readText } = fixture({
      "pom.xml": pom(
        "jenkins-parent",
        ["core", "cli"],
        "<licenses><license><name>MIT</name></license></licenses>",
      ),
      "core/pom.xml": pom("jenkins-core", ["../websocket/spi"]),
      "core/src/main/java/hudson/Main.java": "public class Main {}",
      "cli/pom.xml": pom("cli"),
      "websocket/spi/pom.xml": pom("websocket-spi"),
    });
    const detection = await detectRepository({ entries, readText, repoName: "jenkins" });
    const names = Object.fromEntries(detection.modules.map((module) => [module.path, module.name]));
    expect(names).toEqual({
      "": "jenkins-parent",
      cli: "cli",
      core: "jenkins-core",
      "websocket/spi": "websocket-spi",
    });
    expect(detection.modules.every((module) => module.license === "MIT")).toBe(true);
  });

  it("reads Cargo workspaces with ./ prefixed members, Gradle includes, Go and Python projects", async () => {
    const { entries, readText } = fixture({
      "Cargo.toml": '[workspace]\nmembers = ["./crates/*"]\nexclude = ["crates/skip"]\n',
      "crates/native/Cargo.toml": '[package]\nname = "native"\nlicense = "MIT"\n',
      "crates/skip/Cargo.toml": '[package]\nname = "skip"\n',
      "android/settings.gradle.kts": "",
      "settings.gradle.kts": 'rootProject.name = "app"\ninclude(":app", "lib:util")\n',
      "app/build.gradle.kts": "",
      "lib/util/build.gradle.kts": "",
      "services/api/go.mod": "module github.com/acme/api\n\ngo 1.23\n",
      "tools/py/pyproject.toml":
        '[project]\nname = "acme-tools"\nlicense = { text = "Apache-2.0" }\n',
    });
    const detection = await detectRepository({ entries, readText, repoName: "mixed" });
    const kinds = Object.fromEntries(
      detection.modules.map((module) => [module.path, `${module.kind}:${module.name}`]),
    );
    expect(kinds).toEqual({
      "": "gradle:app",
      app: "gradle:app",
      "crates/native": "cargo:native",
      "lib/util": "gradle:util",
      "services/api": "go:github.com/acme/api",
      "tools/py": "python:acme-tools",
    });
  });

  it("ignores root workspace entries and treats oversized source files as generated", async () => {
    const { entries, readText } = fixture({
      "package.json": JSON.stringify({ name: "app", workspaces: [".", "./", "packages/*"] }),
      "packages/ui/package.json": JSON.stringify({ name: "@app/ui" }),
      "packages/ui/src/Button.tsx": "export const Button = () => null;",
    });
    const huge = { path: "packages/ui/src/Icons.tsx", oid: "huge", bytes: 1_500_000 };
    const detection = await detectRepository({
      entries: [...entries, huge],
      readText,
      repoName: "app",
    });
    expect(detection.modules.map((module) => module.path)).toEqual(["", "packages/ui"]);
    const icons = detection.files.find((file) => file.path === huge.path);
    expect(icons?.kind).toBe("generated");
    expect(detection.sourceTokens).toBeLessThan(100);
  });

  it("falls back to top-level directories when no manifests exist", async () => {
    const files: Record<string, string> = { "README.md": "# app" };
    for (let index = 0; index < 20; index += 1) files[`js/widget${index}.js`] = "export default 1;";
    files["css/style.css"] = "body {}";
    const { entries, readText } = fixture(files);
    const detection = await detectRepository({ entries, readText, repoName: "musicblocks" });
    expect(detection.modules.map((module) => `${module.kind}:${module.path}`)).toEqual([
      "repository:",
      "directory:js",
    ]);
  });
});

describe("detectDocsSources", () => {
  it("detects documentation frameworks and plain markdown folders", () => {
    const markdown = Array.from({ length: 5 }, (_, index) => `docs/guide/page${index}.md`);
    expect(
      detectDocsSources([
        "website/docusaurus.config.ts",
        "mkdocs.yml",
        "docs-site/.vitepress/config.mts",
        "apps/site/src/content/docs/intro.mdx",
        ...markdown,
      ]),
    ).toEqual([
      { kind: "mkdocs", path: "" },
      { kind: "starlight", path: "apps/site" },
      { kind: "markdown", path: "docs" },
      { kind: "vitepress", path: "docs-site" },
      { kind: "docusaurus", path: "website" },
    ]);
  });
});
