import { describe, expect, it } from "vitest";
import type { BlocksDoc } from "@/lib/stories/blocks";
import { checkCodeBlocks, checkPythonStructure, checkSourceSupport, checkSyntax, formatCodeWarnings } from "./code-check";

describe("JSON", () => {
  it("accepts valid JSON and names the problem in invalid JSON", () => {
    expect(checkSyntax('{"a": [1, 2, {"b": null}]}', "json")).toBeNull();
    expect(checkSyntax("{'a': 1}", "json")).toMatch(/is not valid JSON/);
    expect(checkSyntax('{"a": 1,}', "json")).toMatch(/is not valid JSON/);
    expect(checkSyntax("", "json")).toMatch(/is not valid JSON/);
  });
});

describe("JavaScript and TypeScript are parsed, never run", () => {
  it("accepts ordinary snippets, including top-level await, return and JSX", () => {
    expect(checkSyntax("const add = (a, b) => a + b;\nconsole.log(add(1, 2));", "js")).toBeNull();
    expect(checkSyntax("const data = await fetch(url).then((r) => r.json());", "js")).toBeNull();
    expect(checkSyntax("if (!ok) return;\nrun();", "js")).toBeNull();
    expect(checkSyntax("export const View = () => <div className='a'>hi</div>;", "js")).toBeNull();
    expect(checkSyntax("type User = { id: number; name: string };\nconst u: User = { id: 1, name: 'a' };\nfunction f<T>(x: T): T { return x; }", "ts")).toBeNull();
  });

  it("flags a syntax error with its position", () => {
    expect(checkSyntax("const a = (1;", "js")).toMatch(/does not parse as JavaScript: .*\(1:12\)/);
    expect(checkSyntax("function f( {", "ts")).toMatch(/does not parse as TypeScript/);
    expect(checkSyntax("let x = 1;\nlet x = 2;", "js")).toMatch(/already been declared/);
  });

  it("TypeScript syntax is not valid JavaScript", () => {
    expect(checkSyntax("const a: number = 1;", "js")).toMatch(/does not parse as JavaScript/);
  });

  it("does not execute anything: code that would throw, loop or exit is only parsed", () => {
    const g = globalThis as unknown as { __ran?: boolean };
    g.__ran = false;
    expect(checkSyntax("globalThis.__ran = true; while (true) {} process.exit(1);", "js")).toBeNull();
    expect(g.__ran).toBe(false);
  });
});

describe("Python (structure only)", () => {
  const ok = (code: string) => expect(checkPythonStructure(code)).toBeNull();
  const bad = (code: string, message: RegExp) => expect(checkPythonStructure(code)).toMatch(message);

  it("accepts ordinary code: functions, classes, comprehensions, decorators, multi-line calls and strings", () => {
    ok("def add(a, b):\n    return a + b\n\nprint(add(1, 2))");
    ok("class A:\n    def f(self):\n        if self.x:\n            return 1\n        else:\n            return 2\n");
    ok("items = [\n    1,\n    2,\n]\nd = {'a': [1, 2], 'b': (3, 4)}\nsquares = [x * x for x in range(3) if x % 2 == 0]");
    ok('"""Docstring\nwith : colons ( and brackets"""\nx = 1');
    ok("@decorator\ndef f():\n    pass\n");
    ok("x = 'it\\'s'\ny = \"a # not a comment\"  # a comment with ( an open bracket");
    ok("total = 1 + \\\n    2\nprint(total)");
    ok("if x: pass\nelse: pass");
    ok("try:\n    risky()\nexcept ValueError as e:\n    print(e)\nfinally:\n    done()");
    ok("d = {\n    'k': 1,  # note\n}\nlambda_f = lambda x: x + 1");
    ok("# only a comment");
  });

  it("flags an unclosed string, bracket or triple-quoted string", () => {
    bad("print('hello)", /a string is not closed/);
    bad("x = (1, 2", /"\(" is never closed/);
    bad('s = """never closed\nmore', /triple-quoted string is not closed/);
  });

  it("flags a bracket that has no opener, or the wrong one", () => {
    bad("x = 1)", /no matching opening bracket/);
    bad("x = [1, 2)", /does not match the "\[" opened on line 1/);
  });

  it("flags indentation that Python would refuse", () => {
    bad("def f():\nreturn 1", /expected an indented block/);
    bad("def f():\n", /nothing indented under it/);
    bad("x = 1\n    y = 2", /unexpected indent/);
    bad("def f():\n        a = 1\n    b = 2", /does not match any outer level/);
    bad("def f():\n    if x:\n\treturn 1", /tabs and spaces are mixed|expected an indented block|does not match/);
  });

  it("is reported with a message that says it is only a structure check", () => {
    expect(checkSyntax("x = (", "python")).toMatch(/structure check only, not a full parse/);
  });
});

describe("languages without a check pass", () => {
  it.each(["sql", "bash", "cpp", "java", "html", "css", "yaml", "plain"] as const)("%s", (lang) => {
    expect(checkSyntax("this is ( not checked", lang)).toBeNull();
  });
});

describe("what the source does not support", () => {
  const source = "The release notes mention version 2.4.1 of the Acme SDK and the requests library.";

  it("flags a version the source does not mention, and accepts one it does", () => {
    expect(checkSourceSupport('pip install acme==2.4.1', "bash", source)).toEqual([]);
    expect(checkSourceSupport('const v = "9.9.9";', "js", source)).toEqual(["mentions version 9.9.9, which the source does not"]);
    expect(checkSourceSupport("requires python>=3.12 and v3.1", "plain", source)).toEqual(expect.arrayContaining(["mentions version 3.12, which the source does not", "mentions version v3.1, which the source does not"]));
  });

  it("does not mistake ordinary numbers for versions", () => {
    expect(checkSourceSupport("const timeout = 30;\nconst ratio = 0.5;\nfor (let i = 0; i < 100; i++) {}", "js", source)).toEqual([]);
  });

  it("flags a package the source does not mention, but not built-ins, relative imports or packages it names", () => {
    expect(checkSourceSupport('import fs from "fs";\nimport { x } from "./local";\nimport path from "node:path";\nimport a from "acme";', "js", source)).toEqual([]);
    expect(checkSourceSupport('import left from "left-pad";\nconst z = require("@scope/pkg/sub");', "ts", source)).toEqual(['imports "left-pad", which the source does not mention', 'imports "@scope/pkg", which the source does not mention']);
    expect(checkSourceSupport("import os, sys\nimport requests\nfrom flask import Flask\nimport numpy as np", "python", source)).toEqual(['imports "flask", which the source does not mention', 'imports "numpy", which the source does not mention']);
  });
});

describe("a story", () => {
  const doc = (...blocks: unknown[]) => ({ v: 1, blocks }) as BlocksDoc;

  it("numbers the code blocks among themselves and collects every problem", () => {
    const d = doc(
      { id: "a", type: "paragraph", text: "Text." },
      { id: "b", type: "code", language: "json", code: "{ nope" },
      { id: "c", type: "heading", level: 2, text: "H" },
      { id: "d", type: "code", language: "python", code: "import flask\nx = (" },
    );
    const w = checkCodeBlocks(d, "nothing relevant");
    expect(w.map((x) => [x.block, x.language])).toEqual([[1, "json"], [2, "python"], [2, "python"]]);
  });

  it("finds nothing wrong with good code", () => {
    expect(checkCodeBlocks(doc({ id: "b", type: "code", language: "js", code: "console.log(1);" }), "")).toEqual([]);
    expect(formatCodeWarnings([])).toBeNull();
  });

  it("formats the warnings for the admin and says the code was not run", () => {
    const text = formatCodeWarnings([{ block: 1, language: "json", message: "is not valid JSON: x" }, { block: 2, language: "cpp", message: "mentions version 1.2.3, which the source does not" }])!;
    expect(text).toBe("Code check: code block 1 (JSON) is not valid JSON: x; code block 2 (C/C++) mentions version 1.2.3, which the source does not. The code was not run: check it before approving.");
  });
});
