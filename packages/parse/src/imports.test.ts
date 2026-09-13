import { describe, expect, it } from "vitest";
import { parseSource } from "./extract.ts";

const brief = (imports: { specifier: string; kind: string; names?: string[] }[]) =>
  imports.map((ref) => `${ref.kind}:${ref.specifier}${ref.names ? `:${ref.names.join(",")}` : ""}`);

describe("import extraction", () => {
  it("reads static, re-export, require and dynamic imports in TSX", async () => {
    const result = await parseSource(
      "tsx",
      `import a, { b } from "./a";
import type { T } from "@mui/x-data-grid/internals";
export * from "./b";
export { c } from "../c.js";
const d = require("d");
const e = import("./e");
const f = notRequire("ignored");
import "./side";`,
    );
    expect(brief(result.imports)).toEqual([
      "import:./a",
      "import:@mui/x-data-grid/internals",
      "export:./b",
      "export:../c.js",
      "require:d",
      "dynamic:./e",
      "import:./side",
    ]);
  });

  it("reads Java packages, static and wildcard imports", async () => {
    const result = await parseSource(
      "java",
      "package hudson.model;\nimport java.util.List;\nimport static jenkins.util.Timer.get;\nimport hudson.util.*;\nclass Job {}",
    );
    expect(result.packageName).toBe("hudson.model");
    expect(brief(result.imports)).toEqual([
      "import:java.util.List",
      "static:jenkins.util.Timer.get",
      "wildcard:hudson.util",
    ]);
  });

  it("reads Python imports with aliases and relative modules", async () => {
    const result = await parseSource(
      "python",
      "import os.path\nimport a.b as c\nfrom .x import y\nfrom ..pkg.mod import z, w as v\nfrom lib import q\n",
    );
    expect(brief(result.imports)).toEqual([
      "import:os.path",
      "import:a.b",
      "from:.x:y",
      "from:..pkg.mod:z,w",
      "from:lib:q",
    ]);
  });

  it("reads Go package clauses and import paths", async () => {
    const result = await parseSource(
      "go",
      'package main\nimport "fmt"\nimport (\n  api "github.com/acme/api/internal"\n  _ "embed"\n)\n',
    );
    expect(result.packageName).toBe("main");
    expect(brief(result.imports)).toEqual([
      "import:fmt",
      "import:github.com/acme/api/internal",
      "import:embed",
    ]);
  });

  it("reads Rust file modules and use paths but skips inline modules", async () => {
    const result = await parseSource(
      "rust",
      "mod store;\nmod inline { fn f() {} }\nuse crate::runtime::payment::{self, Tx};\nuse super::util;\nuse affine_common::hash;\npub use self::x::*;\n",
    );
    expect(brief(result.imports)).toEqual([
      "mod:store",
      "use:crate::runtime::payment",
      "use:super::util",
      "use:affine_common::hash",
      "use:self::x",
    ]);
  });
});
