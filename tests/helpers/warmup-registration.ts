import { dirname, isAbsolute, resolve } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { helperPath } from "./repo-root";

/**
 * Decide, from a test file's source alone, whether it REGISTERS a cold-spawn warm-up and waits for
 * that warm-up to finish before anything is measured.
 *
 * ## The defect this exists for
 *
 * The coverage guard in tests/ci-workflows/cold-spawn-warmup.test.ts recorded a file as warmed when
 * its text contained the substring "helpers/cold-spawn-warmup" (#5060). A comment, a string literal,
 * or an import left behind after the beforeAll call was deleted all satisfied it. The measured child
 * then pays the cold module-graph load again while the guard in front of it reports the file as
 * handled, which is worse than having no guard at all: the flake comes back and the classified list
 * says it cannot.
 *
 * ## The five stages, and what each one refuses
 *
 * import binding - a runtime import of the exact helper module binds warmColdSpawn or
 * warmModuleGraph to a local name, aliases followed. A same-named local function, a comment and a
 * string bind nothing, and a type-only import loads nothing at run time.
 *
 * hook registration - a bun:test beforeAll binding is called with an inline callback, at the top
 * level or inside a describe, unconditionally. A callback that is only declared registers nothing,
 * and neither does a hook sitting in a helper function nobody calls or behind a false condition.
 *
 * call ownership - the bound name is called on that callback's own direct path: not inside a nested
 * function, not behind a condition, and not through a name the file redeclares or the callback
 * takes as a parameter.
 *
 * completion - the returned promise reaches the hook through await or return. Fire-and-forget and
 * void both leave the hook finishing before the warm-up does, which is the same measured cold start
 * with extra steps, and a warm-up that is only one operand of the returned expression settles the
 * hook on something else.
 *
 * unwarmed exception - a file recorded as unwarmed must not import the helper at all, not merely
 * bind nothing from it, so a namespace import cannot hide a real warm-up behind a false
 * disposition.
 *
 * ## What this cannot decide
 *
 * A structural check reads the shape of a file, not the run. It does not prove the describe holding
 * the registration is reached, and it does not prove the warm-up child loaded anything. That oracle
 * exists separately and already runs on every hosted shard: the helper prints one
 * "[cold-spawn-warmup] graph=..." completion line per warmed graph, and a warm-up that throws fails
 * the file as a setup failure.
 *
 * ## Why a token walk rather than an AST
 *
 * The repository's TypeScript is 7.0.2, the native port, and it publishes no in-process parser. Its
 * entry points are "typescript" (a version constant), "typescript/unstable/sync" and ".../async"
 * (clients that spawn the Go tsgo executable and hold a whole project), and
 * "typescript/unstable/ast" - AST types, type guards, a visitor, and the scanner, with parsing
 * itself left in Go. Reading one file through the RPC client would start a compiler process on
 * every shard of every platform. So this drives the scanner, which is what
 * tests/responses/responses-fetch-helpers-boundary.test.ts already does, and reconstructs only the
 * grammar the five stages need.
 *
 * A token stream has to be driven honestly to stay balanced. A template substitution continues with
 * a rescan at its closing brace, or every template in the file leaks an unmatched brace; a slash is
 * a regular expression or a division depending on the token before it, and guessing wrong swallows
 * whichever delimiters sit between. Both are handled below, and a file that still does not balance
 * is reported as unreadable rather than quietly answered - an unreadable file is a failure, never a
 * pass.
 */

/** The entry points in tests/helpers/cold-spawn-warmup.ts that pay a cold module graph. */
const WARMUP_ENTRY_POINTS: ReadonlySet<string> = new Set(["warmColdSpawn", "warmModuleGraph"]);

/** The bun:test hook a warm-up belongs in, so the cost lands in setup and not in an assertion. */
const REGISTRATION_HOOK = "beforeAll";

type Token = Readonly<{
  kind: SyntaxKind;
  text: string;
  value: string;
  start: number;
  /** Whether trivia before this token held a line break, which is where a statement can end. */
  newline: boolean;
}>;

export type WarmupRegistration = Readonly<{
  /** The helper entry point the hook waits for. */
  helper: string;
  /** The local name it was called through, which is the alias when the import renames it. */
  local: string;
  /** How the promise reaches the hook. */
  completion: "await" | "return";
  /** 1-based line of the call, so a failure points at a place rather than a file. */
  line: number;
}>;

export type WarmupRegistrationReport = Readonly<{
  /** Local names a runtime import bound to a warm-up entry point. */
  bindings: readonly string[];
  /**
   * Whether the file imports the helper module at all, whatever it binds. A file recorded as
   * unwarmed needs this false: a namespace import binds no name this judge follows, so bindings
   * alone would report a real warm-up as an absence.
   */
  importsHelperModule: boolean;
  /** Registrations that survived every stage. */
  registrations: readonly WarmupRegistration[];
  /** Near misses, named with the stage that refused them and the line they sit on. */
  rejected: readonly string[];
  /** Shapes this judge cannot read. Never treated as absence. */
  unreadable: readonly string[];
}>;

/** True only when a registration survived every stage and nothing about the file was unreadable. */
export function warmupIsRegistered(report: WarmupRegistrationReport): boolean {
  return report.unreadable.length === 0 && report.registrations.length > 0;
}

/** Everything the judge refused or could not read, for a failure message that names the reason. */
export function warmupRegistrationComplaints(report: WarmupRegistrationReport): string[] {
  return [...report.unreadable, ...report.rejected];
}

/**
 * A slash opens a regular expression unless the token before it ends a value. This is the standard
 * heuristic, and the one place it stays ambiguous - a closing brace - is read as the end of a
 * statement, because a regular expression after a block is real code and a division by an object
 * literal is not.
 */
const REGEX_CANNOT_FOLLOW: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

const OPENERS: ReadonlyMap<SyntaxKind, SyntaxKind> = new Map([
  [SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken],
  [SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken],
  [SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken],
]);

const CLOSERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
]);

/** Declaration keywords that can rebind a name the file also imports. */
const DECLARATION_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ConstKeyword,
  SyntaxKind.LetKeyword,
  SyntaxKind.VarKeyword,
  SyntaxKind.FunctionKeyword,
]);

/** Where a binding list ends, so the scan for a rebound name does not run into the initializer. */
const BINDING_TERMINATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.EqualsGreaterThanToken,
]);

/**
 * Anything that can decide whether the next statement runs. A warm-up reached through one of these
 * is not a warm-up the file always pays, and if(false) is only the most obvious member.
 */
const CONDITIONAL_TOKENS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.IfKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.QuestionToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Conditionals with a parenthesized head. Their closing paren can end a statement, so the token
 * after it needs an exemption from the line-break rule below: it begins the guarded statement
 * rather than a new one.
 */
const HEADED_CONDITIONALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.IfKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.SwitchKeyword,
]);

/**
 * Tokens a statement can end on. This repository writes its semicolons, but the judge cannot
 * assume that: with no automatic semicolon insertion, one semicolonless guarded statement would
 * leave the conditional flag set and refuse the next, unconditional registration after it.
 */
const CAN_END_STATEMENT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

/**
 * Tokens a statement can begin with. A line break only ends a statement when the next line cannot
 * continue the previous expression, so a line opening with a paren, a bracket, a template or an
 * operator keeps the statement it is part of - the classic hazard automatic semicolon insertion
 * leaves behind. Anything missing from this set only keeps a conditional in force for longer,
 * which refuses a registration rather than accepting one.
 */
const CAN_START_STATEMENT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.ConstKeyword,
  SyntaxKind.LetKeyword,
  SyntaxKind.VarKeyword,
  SyntaxKind.FunctionKeyword,
  SyntaxKind.ClassKeyword,
  SyntaxKind.AsyncKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.TryKeyword,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.ImportKeyword,
  SyntaxKind.ExportKeyword,
]);

/**
 * The only call a registration may sit inside. A hook registered in an uncalled helper function,
 * in a test body, or in an immediately-invoked function is not a hook the file is known to run, and
 * bun:test registers per describe scope, so describe is the whole allowed set.
 */
const REGISTRATION_SCOPE = "describe";

export function analyzeWarmupRegistration(fileName: string, source: string): WarmupRegistrationReport {
  const scan = tokenize(source);
  const rejected: string[] = [];
  if (scan.unreadable.length > 0) {
    return { bindings: [], importsHelperModule: false, registrations: [], rejected, unreadable: scan.unreadable };
  }
  const tokens = scan.tokens;
  const clauses = importClauses(tokens);

  const bindings = new Map<string, string>();
  let importsHelperModule = false;
  for (const clause of clauses) {
    if (!importsTheWarmupHelper(fileName, clause.specifier)) continue;
    importsHelperModule = true;
    if (clause.namespace !== undefined) {
      rejected.push(at(source, clause.start) + "the warm-up helper is imported as a namespace (* as "
        + clause.namespace + "), a shape this judge does not follow; teach it that form before using it");
    }
    for (const name of clause.names) {
      if (!WARMUP_ENTRY_POINTS.has(name.imported)) continue;
      if (name.typeOnly) {
        rejected.push(at(source, clause.start) + name.imported
          + " is imported for its type only, which loads nothing at run time");
        continue;
      }
      bindings.set(name.local, name.imported);
    }
  }

  for (const local of [...bindings.keys()]) {
    const shadow = redeclarationOf(tokens, local);
    if (shadow === undefined) continue;
    rejected.push(at(source, shadow.start) + local
      + " is redeclared in this file, so a call through that name does not reach the imported warm-up");
    bindings.delete(local);
  }
  if (bindings.size === 0) {
    if (rejected.length === 0) {
      rejected.push("no runtime import binds warmColdSpawn or warmModuleGraph from tests/helpers/cold-spawn-warmup");
    }
    return { bindings: [], importsHelperModule, registrations: [], rejected, unreadable: [] };
  }

  const hooks = new Set<string>();
  for (const clause of clauses) {
    if (clause.specifier !== "bun:test") continue;
    for (const name of clause.names) {
      if (name.imported === REGISTRATION_HOOK && !name.typeOnly) hooks.add(name.local);
    }
  }
  if (hooks.size === 0) {
    rejected.push(REGISTRATION_HOOK + " is not imported from bun:test, so nothing registers the warm-up");
    return { bindings: [...bindings.keys()], importsHelperModule, registrations: [], rejected, unreadable: [] };
  }

  const registrations: WarmupRegistration[] = [];
  // One pass carrying the context a registration has to sit in. The call stack is every open call
  // by paren depth, the frames are every open block with the call that owns it, and the statement
  // flag is a condition seen at statement level since the last statement boundary. Without them
  // the scan would accept a hook registered inside if (false), or inside a helper function nobody
  // calls, which registers nothing and reads exactly like a hook that does.
  const callStack: string[] = [];
  const frames: { owner: string; conditional: boolean; parenDepth: number }[] = [];
  let statementConditional = false;
  // The token that begins a guarded statement: the one place where a line break after a closing
  // paren continues the statement rather than ending it.
  let consequentStart = -1;
  let awaitingConsequent = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === SyntaxKind.CloseParenToken) callStack.pop();
    if (token.kind === SyntaxKind.CloseBraceToken) {
      frames.pop();
      statementConditional = false;
    }
    // Statement level is relative to the block we are in, not to the file: everything inside a
    // describe sits one paren deep, so a file-level test would never see a condition in there.
    const frame = frames[frames.length - 1];
    const atStatementLevel = callStack.length === (frame === undefined ? 0 : frame.parenDepth);
    const previousToken = tokens[i - 1];
    if (atStatementLevel && token.newline && i !== consequentStart
      && CAN_START_STATEMENT.has(token.kind)
      && previousToken !== undefined && CAN_END_STATEMENT.has(previousToken.kind)) {
      statementConditional = false;
    }
    if (atStatementLevel && awaitingConsequent && token.kind === SyntaxKind.CloseParenToken) {
      awaitingConsequent = false;
      consequentStart = i + 1;
    }
    if (atStatementLevel && CONDITIONAL_TOKENS.has(token.kind)) {
      statementConditional = true;
      if (HEADED_CONDITIONALS.has(token.kind)) awaitingConsequent = true;
    }
    if (atStatementLevel && token.kind === SyntaxKind.SemicolonToken) statementConditional = false;
    if (token.kind === SyntaxKind.OpenBraceToken) {
      frames.push({
        owner: opensArgumentCallback(tokens, i) ? callStack[callStack.length - 1] ?? "" : "",
        conditional: statementConditional || (frame?.conditional ?? false),
        parenDepth: callStack.length,
      });
      statementConditional = false;
    }
    if (token.kind === SyntaxKind.OpenParenToken) callStack.push(calleeBefore(tokens, i));
    if (token.kind !== SyntaxKind.Identifier || !hooks.has(token.text)) continue;
    const before = tokens[i - 1];
    if (before !== undefined && (before.kind === SyntaxKind.DotToken || before.kind === SyntaxKind.QuestionDotToken)) continue;
    if (tokens[i + 1] === undefined || tokens[i + 1].kind !== SyntaxKind.OpenParenToken) continue;
    const foreignScope = frames.find(entry => entry.owner !== REGISTRATION_SCOPE);
    if (statementConditional || frames.some(entry => entry.conditional) || foreignScope !== undefined) {
      rejected.push(at(source, token.start) + token.text
        + " is registered where the judge cannot see it run: a registration belongs at the top level"
        + " or in a describe, unconditionally");
      continue;
    }
    const body = callbackBody(tokens, i + 2);
    if (body === undefined) {
      rejected.push(at(source, token.start) + token.text
        + " is not given an inline callback here, so the judge cannot see what the hook runs");
      continue;
    }
    const verdict = warmupCallIn(tokens, body, bindings, source);
    if (verdict.found !== undefined) {
      registrations.push({
        helper: verdict.found.helper,
        local: verdict.found.local,
        completion: verdict.found.completion,
        line: lineOf(source, verdict.found.start),
      });
      continue;
    }
    for (const reason of verdict.reasons) rejected.push(reason);
  }
  if (registrations.length === 0 && rejected.length === 0) {
    rejected.push("the warm-up helper is imported but never awaited inside a " + REGISTRATION_HOOK + " callback");
  }
  return { bindings: [...bindings.keys()], importsHelperModule, registrations, rejected, unreadable: [] };
}

/**
 * The name of the call an open paren belongs to, following a member chain back to its root so
 * describe.only counts as describe. An empty string when the paren opens something that is not a
 * plain call, which is a scope this judge refuses rather than guesses at.
 */
function calleeBefore(tokens: readonly Token[], open: number): string {
  let k = open - 1;
  if (tokens[k] === undefined || tokens[k].kind !== SyntaxKind.Identifier) return "";
  let root = tokens[k].text;
  while (tokens[k - 1] !== undefined && tokens[k - 1].kind === SyntaxKind.DotToken
    && tokens[k - 2] !== undefined && tokens[k - 2].kind === SyntaxKind.Identifier) {
    k -= 2;
    root = tokens[k].text;
  }
  return root;
}

/**
 * Whether a block brace opens a callback passed as an argument, which is what a describe body is.
 * The same brace shape opens a helper function nobody calls, and the difference is only what comes
 * before the arrow: an argument starts right after the call paren or a comma, while a declared
 * function starts after an equals sign or a name.
 */
function opensArgumentCallback(tokens: readonly Token[], brace: number): boolean {
  let k = brace - 1;
  if (tokens[k] === undefined || tokens[k].kind !== SyntaxKind.EqualsGreaterThanToken) return false;
  k -= 1;
  if (tokens[k] === undefined) return false;
  if (tokens[k].kind === SyntaxKind.CloseParenToken) {
    const open = openingParen(tokens, k);
    if (open === undefined) return false;
    k = open - 1;
  } else if (tokens[k].kind === SyntaxKind.Identifier) {
    k -= 1;
  } else {
    return false;
  }
  if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.AsyncKeyword) k -= 1;
  const before = tokens[k];
  return before !== undefined
    && (before.kind === SyntaxKind.OpenParenToken || before.kind === SyntaxKind.CommaToken);
}

/** The paren that opens the group closing at close, scanning backwards. */
function openingParen(tokens: readonly Token[], close: number): number | undefined {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (CLOSERS.has(tokens[i].kind)) depth += 1;
    else if (OPENERS.has(tokens[i].kind)) {
      depth -= 1;
      if (depth === 0) return tokens[i].kind === SyntaxKind.OpenParenToken ? i : undefined;
    }
  }
  return undefined;
}

/** The module a binding has to come from. A same-named export of another file is not this one. */
function warmupHelperModule(): string {
  return withoutTsExtension(helperPath("cold-spawn-warmup.ts"));
}

function withoutTsExtension(path: string): string {
  return path.endsWith(".ts") ? path.slice(0, -3) : path;
}

function importsTheWarmupHelper(fileName: string, specifier: string): boolean {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return false;
  const resolved = isAbsolute(specifier) ? specifier : resolve(dirname(fileName), specifier);
  return withoutTsExtension(resolved) === warmupHelperModule();
}

/**
 * The file as a balanced token stream, with the two rescans a raw scan gets wrong.
 *
 * Template substitutions: the scanner returns the closing brace of "${...}" as an ordinary brace,
 * so every template in the file would leak one unmatched brace and every depth after it would be
 * off. The brace depth each substitution opened at is remembered, and at the matching brace the
 * token is rescanned as the template middle or tail it actually is.
 *
 * Regular expressions: the scanner returns a slash, and only the preceding token says whether a
 * regular expression can start there. When it can, the rescan is accepted unless it ran to the end
 * of the line unterminated, in which case the position is rewound and the slash stays a division.
 */
function tokenize(source: string): { tokens: Token[]; unreadable: string[] } {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Token[] = [];
  const unreadable: string[] = [];
  const templates: number[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    let start = scanner.getTokenStart();
    let text = scanner.getTokenText();
    const newline = scanner.hasPrecedingLineBreak();
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
      const afterSlash = scanner.getTokenEnd();
      const previous = tokens[tokens.length - 1];
      if (previous === undefined || !REGEX_CANNOT_FOLLOW.has(previous.kind)) {
        const rescanned = scanner.reScanSlashToken();
        if (rescanned === SyntaxKind.RegularExpressionLiteral && !scanner.isUnterminated()) {
          kind = rescanned;
          start = scanner.getTokenStart();
          text = scanner.getTokenText();
        } else {
          scanner.resetTokenState(afterSlash);
        }
      }
    }
    if (kind === SyntaxKind.CloseBraceToken && templates[templates.length - 1] === braces) {
      templates.pop();
      kind = scanner.reScanTemplateToken(false);
      start = scanner.getTokenStart();
      text = scanner.getTokenText();
    }
    const value = kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : "";
    if (scanner.isUnterminated()) {
      unreadable.push(at(source, start) + "an unterminated literal, so this judge is reading the file wrong");
      return { tokens, unreadable };
    }
    if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) templates.push(braces);
    else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (kind === SyntaxKind.CloseBraceToken) braces -= 1;
    else if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) parens -= 1;
    else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) brackets -= 1;
    if (braces < 0 || parens < 0 || brackets < 0) {
      unreadable.push(at(source, start) + "a closing delimiter with nothing open, so this judge is reading the file wrong");
      return { tokens, unreadable };
    }
    tokens.push({ kind, text, value: value ?? "", start, newline });
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0 || templates.length > 0) {
    unreadable.push("the file does not close every delimiter this judge opened (braces " + braces
      + ", parens " + parens + ", brackets " + brackets + ", open template substitutions "
      + templates.length + ")");
  }
  return { tokens, unreadable };
}

type ImportedName = Readonly<{ imported: string; local: string; typeOnly: boolean }>;

type ImportClause = Readonly<{
  specifier: string;
  names: readonly ImportedName[];
  namespace: string | undefined;
  start: number;
}>;

/**
 * Every import DECLARATION and what it binds. A dynamic import(...) and import.meta are skipped:
 * neither creates the top-level binding a hook can call.
 */
function importClauses(tokens: readonly Token[]): ImportClause[] {
  const clauses: ImportClause[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== SyntaxKind.ImportKeyword) continue;
    const next = tokens[i + 1];
    if (next === undefined) break;
    if (next.kind === SyntaxKind.OpenParenToken || next.kind === SyntaxKind.DotToken) continue;
    if (next.kind === SyntaxKind.StringLiteral) {
      clauses.push({ specifier: next.value, names: [], namespace: undefined, start: tokens[i].start });
      i += 1;
      continue;
    }
    let cursor = i + 1;
    while (cursor < tokens.length
      && tokens[cursor].kind !== SyntaxKind.FromKeyword
      && tokens[cursor].kind !== SyntaxKind.SemicolonToken
      && tokens[cursor].kind !== SyntaxKind.ImportKeyword) cursor += 1;
    const specifier = tokens[cursor + 1];
    if (cursor >= tokens.length || tokens[cursor].kind !== SyntaxKind.FromKeyword) continue;
    if (specifier === undefined || specifier.kind !== SyntaxKind.StringLiteral) continue;
    const clauseIsTypeOnly = next.kind === SyntaxKind.TypeKeyword;
    const names: ImportedName[] = [];
    let namespace: string | undefined;
    for (let k = i + 1; k < cursor; k += 1) {
      if (tokens[k].kind === SyntaxKind.AsteriskToken && tokens[k + 1] !== undefined
        && tokens[k + 1].kind === SyntaxKind.AsKeyword && tokens[k + 2] !== undefined) {
        namespace = tokens[k + 2].text;
        k += 2;
        continue;
      }
      if (tokens[k].kind !== SyntaxKind.OpenBraceToken) continue;
      let entry = k + 1;
      while (entry < cursor && tokens[entry].kind !== SyntaxKind.CloseBraceToken) {
        let entryIsTypeOnly = false;
        const after = tokens[entry + 1];
        if (tokens[entry].kind === SyntaxKind.TypeKeyword && after !== undefined
          && after.kind !== SyntaxKind.CommaToken && after.kind !== SyntaxKind.CloseBraceToken
          && after.kind !== SyntaxKind.AsKeyword) {
          entryIsTypeOnly = true;
          entry += 1;
        }
        const imported = tokens[entry];
        if (imported === undefined) break;
        let local = imported;
        if (tokens[entry + 1] !== undefined && tokens[entry + 1].kind === SyntaxKind.AsKeyword
          && tokens[entry + 2] !== undefined) {
          local = tokens[entry + 2];
          entry += 2;
        }
        names.push({ imported: imported.text, local: local.text, typeOnly: entryIsTypeOnly || clauseIsTypeOnly });
        entry += 1;
        if (tokens[entry] !== undefined && tokens[entry].kind === SyntaxKind.CommaToken) entry += 1;
      }
      k = entry;
    }
    clauses.push({ specifier: specifier.value, names, namespace, start: tokens[i].start });
    i = cursor + 1;
  }
  return clauses;
}

/**
 * A declaration that rebinds an imported name anywhere in the file. Deliberately conservative: any
 * redeclaration, in any scope, disqualifies the import, because the alternative is to decide which
 * scope a call site sits in, and a false pass here is the defect this file exists to stop.
 */
function redeclarationOf(tokens: readonly Token[], name: string): Token | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const following = tokens[i + 1];
    if (token.kind === SyntaxKind.Identifier && token.text === name && following !== undefined
      && following.kind === SyntaxKind.EqualsGreaterThanToken) return token;
    if (!DECLARATION_KEYWORDS.has(token.kind)) continue;
    const limit = Math.min(tokens.length, i + 32);
    for (let k = i + 1; k < limit; k += 1) {
      if (BINDING_TERMINATORS.has(tokens[k].kind)) break;
      if (tokens[k].kind === SyntaxKind.Identifier && tokens[k].text === name) return tokens[k];
    }
  }
  return undefined;
}

type CallbackBody = Readonly<{
  start: number;
  end: number;
  expression: boolean;
  /** Names the callback binds itself. A parameter shadows the import for the whole body. */
  parameters: readonly string[];
}>;

/**
 * The body of the inline callback a hook is given, or undefined when the first argument is not one.
 * A bare identifier is the "declared but not registered" shape: the judge refuses it rather than
 * chasing a variable, because a callback that reaches the hook by name can be reassigned anywhere.
 */
function callbackBody(tokens: readonly Token[], from: number): CallbackBody | undefined {
  let k = from;
  if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.AsyncKeyword) k += 1;
  const head = tokens[k];
  if (head === undefined) return undefined;
  if (head.kind === SyntaxKind.FunctionKeyword) {
    let p = k + 1;
    if (tokens[p] !== undefined && tokens[p].kind === SyntaxKind.Identifier) p += 1;
    if (tokens[p] === undefined || tokens[p].kind !== SyntaxKind.OpenParenToken) return undefined;
    const close = matching(tokens, p);
    if (close === undefined) return undefined;
    const brace = skipReturnType(tokens, close + 1);
    if (tokens[brace] === undefined || tokens[brace].kind !== SyntaxKind.OpenBraceToken) return undefined;
    const end = matching(tokens, brace);
    return end === undefined ? undefined
      : { start: brace + 1, end, expression: false, parameters: identifiersBetween(tokens, p, close) };
  }
  let arrow: number | undefined;
  let parameters: readonly string[] = [];
  if (head.kind === SyntaxKind.OpenParenToken) {
    const close = matching(tokens, k);
    if (close === undefined) return undefined;
    parameters = identifiersBetween(tokens, k, close);
    arrow = skipReturnType(tokens, close + 1);
  } else if (head.kind === SyntaxKind.Identifier && tokens[k + 1] !== undefined
    && tokens[k + 1].kind === SyntaxKind.EqualsGreaterThanToken) {
    parameters = [head.text];
    arrow = k + 1;
  }
  if (arrow === undefined || tokens[arrow] === undefined
    || tokens[arrow].kind !== SyntaxKind.EqualsGreaterThanToken) return undefined;
  const bodyStart = arrow + 1;
  if (tokens[bodyStart] === undefined) return undefined;
  if (tokens[bodyStart].kind === SyntaxKind.OpenBraceToken) {
    const end = matching(tokens, bodyStart);
    return end === undefined ? undefined
      : { start: bodyStart + 1, end, expression: false, parameters };
  }
  return { start: bodyStart, end: argumentEnd(tokens, bodyStart), expression: true, parameters };
}

/** Every identifier inside a delimiter pair, which for a parameter list over-collects on purpose. */
function identifiersBetween(tokens: readonly Token[], open: number, close: number): string[] {
  const names: string[] = [];
  for (let i = open + 1; i < close; i += 1) {
    if (tokens[i].kind === SyntaxKind.Identifier) names.push(tokens[i].text);
  }
  return names;
}

/** Walk past a return-type annotation to the arrow or body brace that follows it. */
function skipReturnType(tokens: readonly Token[], from: number): number {
  let k = from;
  while (k < tokens.length
    && tokens[k].kind !== SyntaxKind.EqualsGreaterThanToken
    && tokens[k].kind !== SyntaxKind.OpenBraceToken
    && tokens[k].kind !== SyntaxKind.CommaToken
    && tokens[k].kind !== SyntaxKind.CloseParenToken) k += 1;
  return k;
}

type CallVerdict = Readonly<{
  found: Readonly<{ helper: string; local: string; completion: "await" | "return"; start: number }> | undefined;
  reasons: readonly string[];
}>;

/**
 * The warm-up call on the callback's own direct path.
 *
 * Direct means depth zero inside the callback body: a call one brace deeper sits in a nested
 * function or a guarded block, and the judge refuses both rather than deciding which. A concise
 * arrow body is the implicit-return form and is accepted, because the hook does receive the promise.
 */
function warmupCallIn(
  tokens: readonly Token[],
  body: CallbackBody,
  bindings: ReadonlyMap<string, string>,
  source: string,
): CallVerdict {
  if (body.expression) {
    let k = body.start;
    let completion: "await" | "return" = "return";
    if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.AwaitKeyword) {
      completion = "await";
      k += 1;
    }
    const call = tokens[k];
    const helper = call === undefined ? undefined : bindings.get(call.text);
    if (call !== undefined && helper !== undefined && call.kind === SyntaxKind.Identifier
      && tokens[k + 1] !== undefined && tokens[k + 1].kind === SyntaxKind.OpenParenToken) {
      if (body.parameters.includes(call.text)) {
        return { found: undefined, reasons: [shadowedByParameter(source, call)] };
      }
      // The hook returns the WHOLE expression. A warm-up that is only its left operand leaves the
      // hook settling on something else, so the call has to be all there is.
      const closes = matching(tokens, k + 1);
      if (closes === undefined || closes + 1 !== body.end) {
        return { found: undefined, reasons: [at(source, call.start) + call.text
          + " is one part of a larger returned expression, so the hook does not settle on it"] };
      }
      return { found: { helper, local: call.text, completion, start: call.start }, reasons: [] };
    }
    return { found: undefined, reasons: [] };
  }
  const reasons: string[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let conditional = false;
  for (let k = body.start; k < body.end; k += 1) {
    const token = tokens[k];
    if (token.kind === SyntaxKind.CloseBraceToken) braces -= 1;
    else if (token.kind === SyntaxKind.CloseParenToken) parens -= 1;
    else if (token.kind === SyntaxKind.CloseBracketToken) brackets -= 1;
    const direct = braces === 0 && parens === 0 && brackets === 0;
    if (direct && CONDITIONAL_TOKENS.has(token.kind)) conditional = true;
    if (direct && (token.kind === SyntaxKind.SemicolonToken || token.kind === SyntaxKind.OpenBraceToken
      || token.kind === SyntaxKind.CloseBraceToken)) conditional = false;
    const helper = bindings.get(token.text);
    const opensCall = tokens[k + 1] !== undefined && tokens[k + 1].kind === SyntaxKind.OpenParenToken;
    if (token.kind === SyntaxKind.Identifier && helper !== undefined && opensCall) {
      const previous = tokens[k - 1];
      const completion = previous === undefined ? undefined
        : previous.kind === SyntaxKind.AwaitKeyword ? "await" as const
        : previous.kind === SyntaxKind.ReturnKeyword ? "return" as const
        : undefined;
      if (!direct) {
        reasons.push(at(source, token.start) + token.text
          + " is called inside a nested function or block, where the judge cannot tell the hook reaches it");
      } else if (conditional) {
        reasons.push(at(source, token.start) + token.text
          + " is reached only through a condition, so the hook does not always pay the warm-up");
      } else if (previous !== undefined && previous.kind === SyntaxKind.EqualsGreaterThanToken) {
        reasons.push(at(source, token.start) + token.text
          + " is the body of an inner arrow function the hook never calls");
      } else if (completion === undefined) {
        reasons.push(at(source, token.start) + token.text
          + " is neither awaited nor returned, so the hook finishes before the warm-up does");
      } else if (body.parameters.includes(token.text)) {
        reasons.push(shadowedByParameter(source, token));
      } else if (completion === "return" && !returnsNothingElse(tokens, k, body)) {
        reasons.push(at(source, token.start) + token.text
          + " is one part of a larger returned expression, so the hook does not settle on it");
      } else {
        return { found: { helper, local: token.text, completion, start: token.start }, reasons: [] };
      }
    }
    if (token.kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (token.kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (token.kind === SyntaxKind.OpenBracketToken) brackets += 1;
  }
  return { found: undefined, reasons };
}

function shadowedByParameter(source: string, token: Token): string {
  return at(source, token.start) + token.text
    + " is a parameter of this callback, which shadows the import for the whole body";
}

/** Whether a returned call is the entire returned expression rather than one operand of it. */
function returnsNothingElse(tokens: readonly Token[], call: number, body: CallbackBody): boolean {
  const closes = matching(tokens, call + 1);
  if (closes === undefined) return false;
  if (closes + 1 === body.end) return true;
  const after = tokens[closes + 1];
  return after !== undefined && after.kind === SyntaxKind.SemicolonToken;
}

/** Index of the delimiter that closes the one at open, or undefined when the file is unbalanced. */
function matching(tokens: readonly Token[], open: number): number | undefined {
  const closer = OPENERS.get(tokens[open].kind);
  if (closer === undefined) return undefined;
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (OPENERS.has(tokens[i].kind)) depth += 1;
    else if (CLOSERS.has(tokens[i].kind)) {
      depth -= 1;
      if (depth === 0) return tokens[i].kind === closer ? i : undefined;
    }
  }
  return undefined;
}

/** Where the argument beginning at start ends: its comma, or the closing paren of the call. */
function argumentEnd(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const kind = tokens[i].kind;
    if (OPENERS.has(kind)) depth += 1;
    else if (CLOSERS.has(kind)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (kind === SyntaxKind.CommaToken && depth === 0) return i;
  }
  return tokens.length;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  const bound = Math.min(offset, source.length);
  for (let i = 0; i < bound; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** "line N: ", the prefix every complaint carries so a failure points at a place. */
function at(source: string, offset: number): string {
  return "line " + lineOf(source, offset) + ": ";
}
