import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import {
  analyzeWarmupRegistration,
  warmupIsRegistered,
  warmupRegistrationComplaints,
} from "../helpers/warmup-registration";

/**
 * The regression set for the invocation oracle in tests/helpers/warmup-registration.ts.
 *
 * #5060: the coverage guard accepted the substring "helpers/cold-spawn-warmup" as proof that a file
 * pays its cold module-graph load in setup, so a comment, a string, or an import left behind after
 * its call was deleted all passed. Every shape named in that report is below, together with the
 * forms that really do warm. A judge that only refused would be as useless as one that only
 * accepted, so both directions are pinned here rather than the refusals alone.
 *
 * The fixtures are source text. They are never imported and never run: this is a structural check
 * and it is scoped like one. The fixture path is a real directory under tests/, so the relative
 * specifier resolves to the real helper module, which is what makes the same-name-from-another-file
 * case fail rather than pass by spelling.
 */
const FIXTURE = repoPath("tests", "ci-workflows", "warmup-registration-fixture.test.ts");

const BUN_TEST = 'import { beforeAll, describe, test } from "bun:test";';
const HELPER = 'import { warmModuleGraph } from "../helpers/cold-spawn-warmup";';

function judge(...lines: string[]) {
  return analyzeWarmupRegistration(FIXTURE, lines.join("\n"));
}

function registers(...lines: string[]): boolean {
  return warmupIsRegistered(judge(...lines));
}

/** The registration shape every warmed file in this repository uses today. */
function hook(...body: string[]): string[] {
  return [
    'describe("subject", () => {',
    "  beforeAll(async () => {",
    ...body.map(line => "    " + line),
    "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    '  test("case", () => {});',
    "});",
  ];
}

describe("warm-up judge: the import binding", () => {
  test("a comment or a string that names the warm-up binds nothing", () => {
    // These two are the defect verbatim. Both contain every character the old substring check
    // looked for, and neither loads a module.
    const commented = judge(BUN_TEST, ...hook("// await warmModuleGraph(options); helpers/cold-spawn-warmup"));
    const quoted = judge(BUN_TEST, ...hook('const note = "warmModuleGraph(options) helpers/cold-spawn-warmup";'));
    expect([warmupIsRegistered(commented), warmupIsRegistered(quoted)]).toEqual([false, false]);
    expect([commented.bindings, quoted.bindings]).toEqual([[], []]);
  });

  test("an import left behind after the call was deleted is not a warm-up", () => {
    // The shape a decayed file actually takes: the import survives review because it looks load
    // bearing, and the hook that used it is gone.
    const report = judge(BUN_TEST, HELPER, ...hook("const unrelated = 1;"));
    expect(warmupIsRegistered(report)).toBe(false);
    expect(report.bindings).toEqual(["warmModuleGraph"]);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("never awaited");
  });

  test("an alias is followed, because renaming the import does not change what it loads", () => {
    const report = judge(
      BUN_TEST,
      'import { warmModuleGraph as warmUp } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmUp(options);"),
    );
    expect(warmupIsRegistered(report)).toBe(true);
    expect(report.registrations).toEqual([
      { helper: "warmModuleGraph", local: "warmUp", completion: "await", line: 5 },
    ]);
  });

  test("the same name from another module is another function", () => {
    expect(registers(
      BUN_TEST,
      'import { warmModuleGraph } from "../helpers/some-other-helper";',
      ...hook("await warmModuleGraph(options);"),
    )).toBe(false);
  });

  test("a type-only import loads nothing at run time", () => {
    const clause = judge(
      BUN_TEST,
      'import type { warmModuleGraph } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmModuleGraph(options);"),
    );
    const inline = judge(
      BUN_TEST,
      'import { type warmModuleGraph } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmModuleGraph(options);"),
    );
    expect([warmupIsRegistered(clause), warmupIsRegistered(inline)]).toEqual([false, false]);
    expect(warmupRegistrationComplaints(clause).join(" ")).toContain("type only");
  });

  test("a local function of the same name is not the shared warm-up", () => {
    expect(registers(
      BUN_TEST,
      "async function warmModuleGraph(options) { return options; }",
      ...hook("await warmModuleGraph(options);"),
    )).toBe(false);
  });

  test("a shape the judge does not read fails loudly instead of passing", () => {
    // A namespace import is legal and would warm. It is refused with its own reason rather than
    // silently, because a judge that quietly ignores what it cannot read is the original defect.
    const report = judge(
      BUN_TEST,
      'import * as warmup from "../helpers/cold-spawn-warmup";',
      ...hook("await warmup.warmModuleGraph(options);"),
    );
    expect(warmupIsRegistered(report)).toBe(false);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("namespace");
    // The unwarmed disposition is guarded by this flag rather than by the bindings, which a
    // namespace import leaves empty while really warming.
    expect(report.importsHelperModule).toBe(true);
  });
});

describe("warm-up judge: the hook registration", () => {
  test("a registration inside describe counts, and so does one at the top level", () => {
    expect(registers(BUN_TEST, HELPER, ...hook("await warmModuleGraph(options);"))).toBe(true);
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(async () => {",
      "  await warmModuleGraph(options);",
      "}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
  });

  test("a callback that is declared but never registered warms nothing", () => {
    expect(registers(
      BUN_TEST,
      HELPER,
      "const warmUpHook = async () => {",
      "  await warmModuleGraph(options);",
      "};",
    )).toBe(false);
  });

  test("a hook handed a name instead of a callback is refused, not guessed", () => {
    // beforeAll(warmUpHook) would work at run time, and the judge still refuses: a name can be
    // reassigned between the declaration and the call, so the file no longer says what runs.
    const report = judge(
      BUN_TEST,
      HELPER,
      "const warmUpHook = async () => { await warmModuleGraph(options); };",
      "beforeAll(warmUpHook, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    );
    expect(warmupIsRegistered(report)).toBe(false);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("inline callback");
  });

  test("beforeAll has to come from bun:test", () => {
    expect(registers(
      'import { describe, test } from "bun:test";',
      'import { beforeAll } from "../helpers/local-hook-shim";',
      HELPER,
      ...hook("await warmModuleGraph(options);"),
    )).toBe(false);
  });

  test("a registration the file never reaches is not a registration", () => {
    // Both shapes call beforeAll with a correct, awaited warm-up, and neither runs: one sits in a
    // helper nobody calls, the other behind a condition that is false. A hook that never registers
    // leaves the measured child paying the cold load, which is the defect wearing the right shape.
    const uncalled = judge(
      BUN_TEST,
      HELPER,
      "function installWarmUp() {",
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "}",
    );
    const guarded = judge(
      BUN_TEST,
      HELPER,
      "if (false) {",
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "}",
    );
    expect([warmupIsRegistered(uncalled), warmupIsRegistered(guarded)]).toEqual([false, false]);
    expect(warmupRegistrationComplaints(uncalled).join(" ")).toContain("cannot see it run");
    // The third is the same hole one level in: a helper declared inside the describe still reads
    // as a describe scope by paren depth alone, and still nobody calls it.
    const inner = judge(
      BUN_TEST,
      HELPER,
      'describe("subject", () => {',
      "  const installWarmUp = () => {",
      "    beforeAll(async () => {",
      "      await warmModuleGraph(options);",
      "    }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "  };",
      "});",
    );
    expect(warmupIsRegistered(inner)).toBe(false);
  });

  test("a semicolonless guarded hook does not poison the registration after it", () => {
    // The guarded one is refused and the plain one is not. Without a statement boundary that does
    // not need a semicolon, the condition would still be set on the next line, and a file whose
    // style omits semicolons would lose a warm-up it really has.
    const report = judge(
      BUN_TEST,
      HELPER,
      "if (false) beforeAll(() => warmModuleGraph(options))",
      "beforeAll(async () => {",
      "  await warmModuleGraph(options);",
      "}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    );
    expect(warmupIsRegistered(report)).toBe(true);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("cannot see it run");
  });
});

describe("warm-up judge: call ownership", () => {
  test("a call inside a nested function is not the hook's own work", () => {
    expect(registers(BUN_TEST, HELPER, ...hook(
      "await runLater(async () => {",
      "  await warmModuleGraph(options);",
      "});",
    ))).toBe(false);
  });

  test("a call behind a condition is not a warm-up the file always pays", () => {
    const braced = judge(BUN_TEST, HELPER, ...hook("if (false) { await warmModuleGraph(options); }"));
    const bare = judge(BUN_TEST, HELPER, ...hook("if (false) await warmModuleGraph(options);"));
    expect([warmupIsRegistered(braced), warmupIsRegistered(bare)]).toEqual([false, false]);
    expect(warmupRegistrationComplaints(bare).join(" ")).toContain("condition");
  });

  test("a redeclared name does not reach the import", () => {
    const report = judge(
      BUN_TEST,
      HELPER,
      "const warmModuleGraph = async () => {};",
      ...hook("await warmModuleGraph(options);"),
    );
    expect(warmupIsRegistered(report)).toBe(false);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("redeclared");
  });

  test("a callback parameter of the same name shadows the import for the whole body", () => {
    // Out of reach of the redeclaration scan: a parameter is bound by the parameter list, with no
    // declaration keyword in front of it to find.
    const report = judge(
      BUN_TEST,
      HELPER,
      'describe("subject", () => {',
      "  beforeAll(async (warmModuleGraph) => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "});",
    );
    expect(warmupIsRegistered(report)).toBe(false);
    expect(warmupRegistrationComplaints(report).join(" ")).toContain("parameter");
  });
});

describe("warm-up judge: completion", () => {
  test("fire and forget leaves the hook finishing before the warm-up does", () => {
    const dropped = judge(BUN_TEST, HELPER, ...hook("warmModuleGraph(options);"));
    const voided = judge(BUN_TEST, HELPER, ...hook("void warmModuleGraph(options);"));
    expect([warmupIsRegistered(dropped), warmupIsRegistered(voided)]).toEqual([false, false]);
    expect(warmupRegistrationComplaints(dropped).join(" ")).toContain("neither awaited nor returned");
  });

  test("await, return, an implicit return and a function expression all connect the promise", () => {
    expect(judge(BUN_TEST, HELPER, ...hook("await warmModuleGraph(options);")).registrations[0].completion)
      .toBe("await");
    expect(judge(BUN_TEST, HELPER, ...hook("return warmModuleGraph(options);")).registrations[0].completion)
      .toBe("return");
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(() => warmModuleGraph(options), COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(async function () {",
      "  await warmModuleGraph(options);",
      "}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
  });

  test("a warm-up that is only part of the returned expression does not settle the hook", () => {
    // Both return something other than the warm-up promise: the right operand of &&, and the right
    // side of a comma expression. The hook settles on that instead, while the warm-up runs on.
    const operand = judge(
      BUN_TEST,
      HELPER,
      "beforeAll(() => warmModuleGraph(options) && ready(), COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    );
    const sequence = judge(BUN_TEST, HELPER, ...hook("return warmModuleGraph(options), ready();"));
    expect([warmupIsRegistered(operand), warmupIsRegistered(sequence)]).toEqual([false, false]);
    expect(warmupRegistrationComplaints(operand).join(" ")).toContain("larger returned expression");
  });
});

describe("warm-up judge: reading the file at all", () => {
  test("a template substitution and a regular expression do not derail the token walk", () => {
    // Both are scanner rescans rather than plain tokens. Read naively, the closing brace of a
    // substitution leaks an unmatched brace and a regular expression is read as a division that
    // swallows whatever delimiters sit inside it, and either one moves the rest of the file to a
    // depth where a real call no longer looks direct.
    expect(registers(BUN_TEST, HELPER, ...hook(
      "const label = `graph-${options.graph}-${JSON.stringify({ warm: true })}`;",
      'const trimmed = label.replace(/[^a-z-]{1,4}/g, "");',
      "await warmModuleGraph(options);",
    ))).toBe(true);
  });

  test("a file the judge cannot read is a failure, never an absence", () => {
    const report = judge(BUN_TEST, HELPER, 'describe("unclosed", () => {');
    expect(report.unreadable.length).toBeGreaterThan(0);
    expect(warmupIsRegistered(report)).toBe(false);
  });
});
