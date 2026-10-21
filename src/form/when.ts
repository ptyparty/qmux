export type Value = string | number | boolean | string[] | null | undefined;

export type Expr =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "ref"; id: string }
  | { kind: "not"; operand: Expr }
  | { kind: "and" | "or"; left: Expr; right: Expr }
  | { kind: "compare"; op: CompareOp; left: Expr; right: Expr }
  | { kind: "call"; fn: FunctionName; args: Expr[] };

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

const functionArity = { selected: 2, count: 1, empty: 1 } as const;
type FunctionName = keyof typeof functionArity;

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

export class WhenSyntaxError extends Error {}

export function parseWhen(source: string): Expr {
  const parser = new Parser(tokenize(source));
  const expr = parser.parseOr();
  parser.expectEnd();
  return expr;
}

export function referencedIds(expr: Expr): string[] {
  switch (expr.kind) {
    case "literal":
      return [];
    case "ref":
      return [expr.id];
    case "not":
      return referencedIds(expr.operand);
    case "and":
    case "or":
    case "compare":
      return [...referencedIds(expr.left), ...referencedIds(expr.right)];
    case "call":
      return expr.args.flatMap(referencedIds);
  }
}

export function evaluateWhen(expr: Expr, lookup: (id: string) => Value): boolean {
  return truthy(evaluate(expr, lookup));
}

function evaluate(expr: Expr, lookup: (id: string) => Value): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return lookup(expr.id);
    case "not":
      return !truthy(evaluate(expr.operand, lookup));
    case "and":
      return truthy(evaluate(expr.left, lookup)) && truthy(evaluate(expr.right, lookup));
    case "or":
      return truthy(evaluate(expr.left, lookup)) || truthy(evaluate(expr.right, lookup));
    case "compare":
      return compare(expr.op, evaluate(expr.left, lookup), evaluate(expr.right, lookup));
    case "call":
      return call(expr.fn, expr.args.map((arg) => evaluate(arg, lookup)));
  }
}

function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function compare(op: CompareOp, left: Value, right: Value): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
  }
  if (typeof left !== "number" || typeof right !== "number") return false;
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

function call(fn: FunctionName, args: Value[]): Value {
  const [subject, needle] = args;
  switch (fn) {
    case "selected":
      return Array.isArray(subject) ? subject.includes(String(needle)) : subject === needle;
    case "count":
      if (Array.isArray(subject)) return subject.length;
      return subject === null || subject === undefined || subject === "" ? 0 : 1;
    case "empty":
      return !truthy(subject);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      i += whitespace[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (ident) {
      tokens.push({ kind: "ident", value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[<>!(),])/.exec(rest);
    if (op) {
      tokens.push({ kind: "op", value: op[0] });
      i += op[0].length;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const { value, length } = readString(rest);
      tokens.push({ kind: "string", value });
      i += length;
      continue;
    }
    throw new WhenSyntaxError(`unexpected character ${JSON.stringify(rest[0])} at position ${i}`);
  }
  return tokens;
}

function readString(rest: string): { value: string; length: number } {
  const quote = rest[0];
  let value = "";
  for (let j = 1; j < rest.length; j++) {
    const ch = rest[j];
    if (ch === quote) return { value, length: j + 1 };
    if (ch === "\\" && j + 1 < rest.length) {
      value += rest[++j];
      continue;
    }
    value += ch;
  }
  throw new WhenSyntaxError("unterminated string");
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptOp("||")) left = { kind: "or", left, right: this.parseAnd() };
    return left;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token) throw new WhenSyntaxError(`unexpected ${describe(token)}`);
  }

  private parseAnd(): Expr {
    let left = this.parseCompare();
    while (this.acceptOp("&&")) left = { kind: "and", left, right: this.parseCompare() };
    return left;
  }

  private parseCompare(): Expr {
    const left = this.parseNot();
    const token = this.peek();
    if (token?.kind === "op" && isCompareOp(token.value)) {
      this.position++;
      return { kind: "compare", op: token.value, left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.acceptOp("!")) return { kind: "not", operand: this.parseNot() };
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.next();
    switch (token.kind) {
      case "number":
      case "string":
        return { kind: "literal", value: token.value };
      case "op":
        if (token.value !== "(") throw new WhenSyntaxError(`unexpected ${describe(token)}`);
        return this.finishParenthesized();
      case "ident":
        return this.parseIdent(token.value);
    }
  }

  private parseIdent(name: string): Expr {
    if (name === "true" || name === "false") return { kind: "literal", value: name === "true" };
    if (!this.acceptOp("(")) return { kind: "ref", id: name };
    if (!isFunctionName(name)) throw new WhenSyntaxError(`unknown function ${name}`);
    const args = this.parseArgs();
    if (args.length !== functionArity[name]) {
      throw new WhenSyntaxError(`${name} takes ${functionArity[name]} argument(s), got ${args.length}`);
    }
    return { kind: "call", fn: name, args };
  }

  private parseArgs(): Expr[] {
    const args: Expr[] = [];
    if (this.acceptOp(")")) return args;
    do args.push(this.parseOr());
    while (this.acceptOp(","));
    this.expectOp(")");
    return args;
  }

  private finishParenthesized(): Expr {
    const inner = this.parseOr();
    this.expectOp(")");
    return inner;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position++];
    if (!token) throw new WhenSyntaxError("unexpected end of expression");
    return token;
  }

  private acceptOp(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === value) {
      this.position++;
      return true;
    }
    return false;
  }

  private expectOp(value: string): void {
    if (!this.acceptOp(value)) {
      const token = this.peek();
      throw new WhenSyntaxError(`expected ${value} but found ${token ? describe(token) : "end of expression"}`);
    }
  }
}

function isCompareOp(value: string): value is CompareOp {
  return ["==", "!=", "<", "<=", ">", ">="].includes(value);
}

function isFunctionName(name: string): name is FunctionName {
  return Object.hasOwn(functionArity, name);
}

function describe(token: Token): string {
  return token.kind === "op" ? `"${token.value}"` : `${token.kind} ${JSON.stringify(token.value)}`;
}
