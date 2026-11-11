/**
 * Two-pass assembler for the Pipewright RV32IM subset.
 *
 * Supported syntax (GNU as flavoured):
 *   - Comments start with `#` or `//`.
 *   - Labels: `name:` (several per line allowed), local or global alike.
 *   - Sections: `.text`, `.data`, `.section .text|.data|.rodata|.bss`.
 *   - Data: `.word`, `.half`, `.byte`, `.ascii`, `.asciz`/`.string`,
 *     `.space`/`.zero`, `.align n` (2^n bytes), `.balign n`.
 *   - Constants: `.equ name, expr` / `.set name, expr`.
 *   - Ignored: `.globl`, `.global`, `.type`, `.size`, `.file`, `.option`, `.p2align` in text.
 *   - Expressions: integers (decimal, 0x, 0b, 'c'), symbols, parentheses,
 *     `* /`, `+ -`, `<< >>` (C precedence), `%hi(expr)`, `%lo(expr)`.
 *   - The pseudo-instructions listed in PSEUDO_SIZES.
 *
 * Code lives at TEXT_BASE, data at DATA_BASE; addresses are absolute, so
 * `la` expands to `lui`+`addi`.
 */
import { isOpcode, OPCODES, parseReg, type Instr, type Opcode } from './isa';

export const TEXT_BASE = 0x0001_0000;
export const DATA_BASE = 0x1000_0000;
export const STACK_TOP = 0x7fff_fff0;

export interface Program {
  /** Instructions in address order; instrs[i].pc === textBase + 4 * i. */
  instrs: Instr[];
  textBase: number;
  /** Address where execution starts: `_start`, else `main`, else textBase. */
  entry: number;
  dataBase: number;
  /** Initial contents of the data section, starting at dataBase. */
  data: Uint8Array;
  /** Labels and `.equ` constants. */
  symbols: Map<string, number>;
}

export interface AsmDiagnostic {
  line: number;
  message: string;
}

export class AssemblerError extends Error {
  constructor(readonly diagnostics: AsmDiagnostic[]) {
    super(diagnostics.map((d) => `line ${d.line}: ${d.message}`).join('\n'));
    this.name = 'AssemblerError';
  }
}

class LineError extends Error {}

type Section = 'text' | 'data';

interface InstrItem {
  kind: 'instr';
  mnemonic: string;
  operands: string[];
  addr: number;
  size: number; // number of machine instructions
  line: number;
  source: string;
}

interface DataItem {
  kind: 'data';
  directive: string;
  args: string[];
  addr: number;
  line: number;
}

type Item = InstrItem | DataItem;

// ---------------------------------------------------------------------------
// Lexing helpers

function stripComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '#') return line.slice(0, i);
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Split on top-level commas (not inside parentheses or quotes). */
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

const IDENT = /^[A-Za-z_.$][\w.$]*$/;

function parseString(s: string): Uint8Array {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') throw new LineError(`expected string literal, got '${s}'`);
  const bytes: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    let c = s[i]!;
    if (c === '\\') {
      c = s[++i] ?? '';
      const esc: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '"': 34, "'": 39 };
      if (!(c in esc)) throw new LineError(`unknown escape '\\${c}'`);
      bytes.push(esc[c]!);
    } else {
      const code = c.charCodeAt(0);
      if (code > 0x7f) throw new LineError('only ASCII strings are supported');
      bytes.push(code);
    }
  }
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// Expressions

type Lookup = (name: string) => number | undefined;

/** Thrown when an expression references a symbol that is not (yet) known. */
class UnresolvedSymbol extends LineError {}

export function hi20(v: number): number {
  return ((v + 0x800) >>> 12) & 0xfffff;
}

export function lo12(v: number): number {
  return ((v & 0xfff) << 20) >> 20;
}

function evalExpr(src: string, lookup: Lookup): number {
  let pos = 0;
  const s = src.trim();
  const ws = () => {
    while (pos < s.length && /\s/.test(s[pos]!)) pos++;
  };
  const term = (): number => {
    ws();
    if (s[pos] === '-') {
      pos++;
      return -term();
    }
    if (s[pos] === '+') {
      pos++;
      return term();
    }
    if (s[pos] === '(') {
      pos++;
      const v = sum();
      ws();
      if (s[pos] !== ')') throw new LineError(`missing ')' in '${src}'`);
      pos++;
      return v;
    }
    if (s[pos] === '%') {
      const m = /^%(hi|lo)\s*\(/.exec(s.slice(pos));
      if (!m) throw new LineError(`unknown relocation in '${src}'`);
      pos += m[0].length;
      const v = sum();
      ws();
      if (s[pos] !== ')') throw new LineError(`missing ')' in '${src}'`);
      pos++;
      return m[1] === 'hi' ? hi20(v) : lo12(v);
    }
    if (s[pos] === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(s.slice(pos));
      if (!m) throw new LineError(`bad character literal in '${src}'`);
      pos += m[0].length;
      const body = m[1]!;
      return body.length === 2 ? parseString(`"${body}"`)[0]! : body.charCodeAt(0);
    }
    const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)/.exec(s.slice(pos));
    if (num) {
      pos += num[0].length;
      const t = num[0].replace(/_/g, '');
      const v = t.startsWith('0b') || t.startsWith('0B') ? parseInt(t.slice(2), 2) : Number(t);
      if (!Number.isFinite(v)) throw new LineError(`bad number '${num[0]}'`);
      return v;
    }
    const id = /^[A-Za-z_.$][\w.$]*/.exec(s.slice(pos));
    if (id) {
      pos += id[0].length;
      const v = lookup(id[0]);
      if (v === undefined) throw new UnresolvedSymbol(`undefined symbol '${id[0]}'`);
      return v;
    }
    throw new LineError(`cannot parse expression '${src}'`);
  };
  const product = (): number => {
    let v = term();
    for (;;) {
      ws();
      const c = s[pos];
      if (c === '*') {
        pos++;
        v *= term();
      } else if (c === '/') {
        pos++;
        const d = term();
        if (d === 0) throw new LineError(`division by zero in '${src}'`);
        v = Math.trunc(v / d);
      } else return v;
    }
  };
  const additive = (): number => {
    let v = product();
    for (;;) {
      ws();
      const c = s[pos];
      if (c === '+') {
        pos++;
        v += product();
      } else if (c === '-') {
        pos++;
        v -= product();
      } else return v;
    }
  };
  const sum = (): number => {
    let v = additive();
    for (;;) {
      ws();
      const op = s.slice(pos, pos + 2);
      if (op === '<<') {
        pos += 2;
        v = v * 2 ** additive();
      } else if (op === '>>') {
        pos += 2;
        v = Math.floor(v / 2 ** additive());
      } else return v;
    }
  };
  if (s === '') throw new LineError('missing operand');
  const v = sum();
  ws();
  if (pos !== s.length) throw new LineError(`unexpected '${s.slice(pos)}' in '${src}'`);
  return v;
}

// ---------------------------------------------------------------------------
// Pseudo-instructions

/** Number of machine instructions each pseudo expands to (li and lw-symbol are computed). */
const PSEUDO_SIZES: Record<string, number> = {
  nop: 1, mv: 1, not: 1, neg: 1, seqz: 1, snez: 1, sltz: 1, sgtz: 1,
  beqz: 1, bnez: 1, blez: 1, bgez: 1, bltz: 1, bgtz: 1,
  bgt: 1, ble: 1, bgtu: 1, bleu: 1,
  j: 1, jr: 1, ret: 1, call: 1, tail: 1,
  la: 2, li: 0, // li: computed
};

function fitsSigned(v: number, bits: number): boolean {
  const lim = 2 ** (bits - 1);
  return v >= -lim && v < lim;
}

/** Normalise a constant to a 32-bit pattern, accepting -2^31..2^32-1. */
function toInt32(v: number): number {
  if (!Number.isInteger(v) || v < -(2 ** 31) || v > 2 ** 32 - 1) throw new LineError(`value ${v} does not fit in 32 bits`);
  return v | 0;
}

/** True when `operand` is a memory operand of the form `expr(reg)` or `(reg)`. */
function memOperand(operand: string): { offset: string; base: string } | null {
  const m = /^(.*)\(\s*([A-Za-z0-9_$]+)\s*\)$/.exec(operand.trim());
  if (!m || parseReg(m[2]!) === undefined) return null;
  return { offset: m[1]!.trim() || '0', base: m[2]! };
}

// ---------------------------------------------------------------------------
// Assembler

export function assemble(source: string): Program {
  const diagnostics: AsmDiagnostic[] = [];
  const symbols = new Map<string, number>();
  const equs = new Set<string>();
  const items: Item[] = [];
  const cursor: Record<Section, number> = { text: TEXT_BASE, data: DATA_BASE };
  let section: Section = 'text';

  const defineSymbol = (name: string, value: number, line: number) => {
    if (!IDENT.test(name)) throw new LineError(`invalid symbol name '${name}'`);
    if (symbols.has(name)) {
      diagnostics.push({ line, message: `symbol '${name}' redefined` });
      return;
    }
    symbols.set(name, value);
  };

  /** Lookup that only sees `.equ` constants defined so far (for pass-1 sizing). */
  const constLookup: Lookup = (n) => (equs.has(n) ? symbols.get(n) : undefined);
  const fullLookup: Lookup = (n) => symbols.get(n);

  // ---- Pass 1: labels, sections, sizes ----
  const lines = source.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    try {
      let text = stripComment(raw).trim();
      // Labels
      for (;;) {
        const m = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(text);
        if (!m) break;
        defineSymbol(m[1]!, cursor[section], lineNo);
        text = text.slice(m[0].length).trim();
      }
      if (text === '') return;

      const sp = text.search(/\s/);
      const head = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
      const args = rest === '' ? [] : splitOperands(rest);

      if (head.startsWith('.')) {
        switch (head) {
          case '.text':
            section = 'text';
            return;
          case '.data':
          case '.rodata':
          case '.bss':
            section = 'data';
            return;
          case '.section': {
            const name = (args[0] ?? '').split(/[\s,]/)[0]!;
            if (name === '.text' || name.startsWith('.text.')) section = 'text';
            else if (/^\.(data|rodata|bss|sdata|sbss)/.test(name)) section = 'data';
            else throw new LineError(`unsupported section '${name}'`);
            return;
          }
          case '.globl':
          case '.global':
          case '.local':
          case '.type':
          case '.size':
          case '.file':
          case '.option':
          case '.ident':
            return;
          case '.equ':
          case '.set': {
            if (args.length !== 2) throw new LineError(`${head} expects a name and a value`);
            defineSymbol(args[0]!, evalExpr(args[1]!, fullLookup), lineNo);
            equs.add(args[0]!);
            return;
          }
          case '.align':
          case '.p2align':
          case '.balign': {
            const n = evalExpr(args[0] ?? '', constLookup);
            const bytes = head === '.balign' ? n : 2 ** n;
            if (!Number.isInteger(bytes) || bytes < 1 || (bytes & (bytes - 1)) !== 0) throw new LineError(`bad alignment ${n}`);
            if (section === 'text') {
              if (bytes > 4) throw new LineError('alignment above 4 bytes is not supported in .text');
              return;
            }
            const aligned = Math.ceil(cursor.data / bytes) * bytes;
            if (aligned !== cursor.data) {
              items.push({ kind: 'data', directive: '.space', args: [String(aligned - cursor.data)], addr: cursor.data, line: lineNo });
              cursor.data = aligned;
            }
            return;
          }
        }
        // Data-emitting directives
        if (section === 'text') throw new LineError(`data directive '${head}' in .text is not supported`);
        let size: number;
        switch (head) {
          case '.word':
          case '.long':
            size = 4 * args.length;
            break;
          case '.half':
          case '.short':
            size = 2 * args.length;
            break;
          case '.byte':
            size = args.length;
            break;
          case '.ascii':
            size = args.reduce((n, a) => n + parseString(a).length, 0);
            break;
          case '.asciz':
          case '.string':
            size = args.reduce((n, a) => n + parseString(a).length + 1, 0);
            break;
          case '.space':
          case '.zero':
            size = evalExpr(args[0] ?? '', constLookup);
            if (!Number.isInteger(size) || size < 0) throw new LineError(`bad size ${size}`);
            break;
          default:
            throw new LineError(`unknown directive '${head}'`);
        }
        if (size === 0 && args.length === 0) throw new LineError(`${head} needs at least one value`);
        items.push({ kind: 'data', directive: head, args, addr: cursor.data, line: lineNo });
        cursor.data += size;
        return;
      }

      // Instruction or pseudo-instruction
      if (section !== 'text') throw new LineError(`instruction '${head}' outside .text`);
      let size: number;
      if (isOpcode(head)) {
        size = 1;
        if (OPCODES[head].format === 'LOAD' && args.length === 2 && !memOperand(args[1]!)) size = 2; // lw rd, symbol
      } else if (head in PSEUDO_SIZES) {
        size = PSEUDO_SIZES[head]!;
        if (head === 'li') {
          if (args.length !== 2) throw new LineError('li expects rd, imm');
          try {
            const v = toInt32(evalExpr(args[1]!, constLookup));
            size = fitsSigned(v, 12) || lo12(v) === 0 ? 1 : 2;
          } catch (e) {
            if (!(e instanceof UnresolvedSymbol)) throw e;
            size = 2;
          }
        }
      } else {
        throw new LineError(`unknown instruction '${head}'`);
      }
      items.push({ kind: 'instr', mnemonic: head, operands: args, addr: cursor.text, size, line: lineNo, source: text });
      cursor.text += 4 * size;
    } catch (e) {
      if (e instanceof LineError) diagnostics.push({ line: lineNo, message: e.message });
      else throw e;
    }
  });

  // ---- Pass 2: encode ----
  const instrs: Instr[] = [];
  const data = new Uint8Array(cursor.data - DATA_BASE);

  for (const item of items) {
    try {
      if (item.kind === 'data') emitData(item, data, fullLookup);
      else {
        const out = expand(item, fullLookup);
        if (out.length !== item.size) throw new Error(`internal: size mismatch for '${item.source}'`);
        instrs.push(...out);
      }
    } catch (e) {
      if (e instanceof LineError) diagnostics.push({ line: item.line, message: e.message });
      else throw e;
    }
  }

  if (diagnostics.length > 0) {
    diagnostics.sort((a, b) => a.line - b.line);
    throw new AssemblerError(diagnostics);
  }

  const entry = symbols.get('_start') ?? symbols.get('main') ?? TEXT_BASE;
  return { instrs, textBase: TEXT_BASE, entry, dataBase: DATA_BASE, data, symbols };
}

function emitData(item: DataItem, data: Uint8Array, lookup: Lookup): void {
  let off = item.addr - DATA_BASE;
  const put = (v: number, bytes: number) => {
    for (let i = 0; i < bytes; i++) data[off++] = (v >>> (8 * i)) & 0xff;
  };
  const value = (a: string, bits: number) => {
    const v = evalExpr(a, lookup);
    if (!Number.isInteger(v) || v < -(2 ** (bits - 1)) || v > 2 ** bits - 1) throw new LineError(`value ${v} does not fit in ${bits} bits`);
    return v;
  };
  switch (item.directive) {
    case '.word':
    case '.long':
      item.args.forEach((a) => put(value(a, 32), 4));
      return;
    case '.half':
    case '.short':
      item.args.forEach((a) => put(value(a, 16), 2));
      return;
    case '.byte':
      item.args.forEach((a) => put(value(a, 8), 1));
      return;
    case '.ascii':
    case '.asciz':
    case '.string':
      for (const a of item.args) {
        for (const b of parseString(a)) put(b, 1);
        if (item.directive !== '.ascii') put(0, 1);
      }
      return;
    case '.space':
    case '.zero':
      return; // already zero
  }
}

/** Expand one source line into machine instructions. */
function expand(item: InstrItem, lookup: Lookup): Instr[] {
  const { mnemonic: m, operands: ops, addr, line, source } = item;
  const mk = (op: Opcode, f: Partial<Pick<Instr, 'rd' | 'rs1' | 'rs2' | 'imm'>>, at = addr): Instr => ({
    op, rd: f.rd ?? 0, rs1: f.rs1 ?? 0, rs2: f.rs2 ?? 0, imm: f.imm ?? 0, pc: at, line, source,
  });

  const want = (n: number) => {
    if (ops.length !== n) throw new LineError(`'${m}' expects ${n} operand${n === 1 ? '' : 's'}, got ${ops.length}`);
  };
  const reg = (s: string | undefined): number => {
    const r = parseReg((s ?? '').trim());
    if (r === undefined) throw new LineError(`expected register, got '${s ?? ''}'`);
    return r;
  };
  const imm = (s: string, bits: number, signed = true): number => {
    const v = evalExpr(s, lookup);
    const ok = signed ? fitsSigned(v, bits) : v >= 0 && v < 2 ** bits;
    if (!Number.isInteger(v) || !ok) throw new LineError(`immediate ${v} out of range for ${signed ? 'signed' : 'unsigned'} ${bits}-bit field`);
    return v;
  };
  const target = (s: string, bits: number, at = addr): number => {
    const off = evalExpr(s, lookup) - at;
    if (off % 2 !== 0) throw new LineError(`branch target '${s}' is misaligned`);
    if (!fitsSigned(off, bits)) throw new LineError(`branch target '${s}' is out of range`);
    return off;
  };
  const mem = (s: string): { base: number; offset: number } => {
    const mo = memOperand(s);
    if (!mo) throw new LineError(`expected memory operand 'offset(reg)', got '${s}'`);
    return { base: reg(mo.base), offset: imm(mo.offset, 12) };
  };

  if (isOpcode(m)) {
    switch (OPCODES[m].format) {
      case 'R':
        want(3);
        return [mk(m, { rd: reg(ops[0]), rs1: reg(ops[1]), rs2: reg(ops[2]) })];
      case 'I':
        want(3);
        return [mk(m, { rd: reg(ops[0]), rs1: reg(ops[1]), imm: imm(ops[2]!, 12) })];
      case 'SH':
        want(3);
        return [mk(m, { rd: reg(ops[0]), rs1: reg(ops[1]), imm: imm(ops[2]!, 5, false) })];
      case 'LOAD': {
        want(2);
        const rd = reg(ops[0]);
        if (!memOperand(ops[1]!)) {
          // lw rd, symbol  =>  lui rd, %hi(symbol); lw rd, %lo(symbol)(rd)
          const a = toInt32(evalExpr(ops[1]!, lookup));
          return [mk('lui', { rd, imm: hi20(a) }), mk(m, { rd, rs1: rd, imm: lo12(a) }, addr + 4)];
        }
        const { base, offset } = mem(ops[1]!);
        return [mk(m, { rd, rs1: base, imm: offset })];
      }
      case 'S': {
        want(2);
        const { base, offset } = mem(ops[1]!);
        return [mk(m, { rs2: reg(ops[0]), rs1: base, imm: offset })];
      }
      case 'B':
        want(3);
        return [mk(m, { rs1: reg(ops[0]), rs2: reg(ops[1]), imm: target(ops[2]!, 13) })];
      case 'U':
        want(2);
        return [mk(m, { rd: reg(ops[0]), imm: imm(ops[1]!, 20, false) })];
      case 'J':
        if (ops.length === 1) return [mk('jal', { rd: 1, imm: target(ops[0]!, 21) })];
        want(2);
        return [mk('jal', { rd: reg(ops[0]), imm: target(ops[1]!, 21) })];
      case 'JR': {
        if (ops.length === 1) {
          const mo = memOperand(ops[0]!);
          if (mo) return [mk('jalr', { rd: 1, rs1: reg(mo.base), imm: imm(mo.offset, 12) })];
          return [mk('jalr', { rd: 1, rs1: reg(ops[0]) })];
        }
        if (ops.length === 2) {
          const { base, offset } = mem(ops[1]!);
          return [mk('jalr', { rd: reg(ops[0]), rs1: base, imm: offset })];
        }
        want(3);
        return [mk('jalr', { rd: reg(ops[0]), rs1: reg(ops[1]), imm: imm(ops[2]!, 12) })];
      }
      case 'N':
        want(0);
        return [mk(m, {})];
    }
  }

  switch (m) {
    case 'nop':
      want(0);
      return [mk('addi', {})];
    case 'mv':
      want(2);
      return [mk('addi', { rd: reg(ops[0]), rs1: reg(ops[1]) })];
    case 'not':
      want(2);
      return [mk('xori', { rd: reg(ops[0]), rs1: reg(ops[1]), imm: -1 })];
    case 'neg':
      want(2);
      return [mk('sub', { rd: reg(ops[0]), rs2: reg(ops[1]) })];
    case 'seqz':
      want(2);
      return [mk('sltiu', { rd: reg(ops[0]), rs1: reg(ops[1]), imm: 1 })];
    case 'snez':
      want(2);
      return [mk('sltu', { rd: reg(ops[0]), rs2: reg(ops[1]) })];
    case 'sltz':
      want(2);
      return [mk('slt', { rd: reg(ops[0]), rs1: reg(ops[1]) })];
    case 'sgtz':
      want(2);
      return [mk('slt', { rd: reg(ops[0]), rs2: reg(ops[1]) })];
    case 'beqz':
    case 'bnez':
    case 'bgez':
    case 'bltz': {
      want(2);
      const op = ({ beqz: 'beq', bnez: 'bne', bgez: 'bge', bltz: 'blt' } as const)[m];
      return [mk(op, { rs1: reg(ops[0]), rs2: 0, imm: target(ops[1]!, 13) })];
    }
    case 'blez':
    case 'bgtz': {
      // blez rs, L == bge x0, rs, L ; bgtz rs, L == blt x0, rs, L
      want(2);
      return [mk(m === 'blez' ? 'bge' : 'blt', { rs1: 0, rs2: reg(ops[0]), imm: target(ops[1]!, 13) })];
    }
    case 'bgt':
    case 'ble':
    case 'bgtu':
    case 'bleu': {
      want(3);
      const op = ({ bgt: 'blt', ble: 'bge', bgtu: 'bltu', bleu: 'bgeu' } as const)[m];
      return [mk(op, { rs1: reg(ops[1]), rs2: reg(ops[0]), imm: target(ops[2]!, 13) })];
    }
    case 'j':
    case 'tail':
      want(1);
      return [mk('jal', { rd: 0, imm: target(ops[0]!, 21) })];
    case 'call':
      want(1);
      return [mk('jal', { rd: 1, imm: target(ops[0]!, 21) })];
    case 'jr':
      want(1);
      return [mk('jalr', { rd: 0, rs1: reg(ops[0]) })];
    case 'ret':
      want(0);
      return [mk('jalr', { rd: 0, rs1: 1 })];
    case 'la': {
      want(2);
      const rd = reg(ops[0]);
      const a = toInt32(evalExpr(ops[1]!, lookup));
      return [mk('lui', { rd, imm: hi20(a) }), mk('addi', { rd, rs1: rd, imm: lo12(a) }, addr + 4)];
    }
    case 'li': {
      want(2);
      const rd = reg(ops[0]);
      const v = toInt32(evalExpr(ops[1]!, lookup));
      if (item.size === 1) {
        return fitsSigned(v, 12) ? [mk('addi', { rd, imm: v })] : [mk('lui', { rd, imm: hi20(v) })];
      }
      return [mk('lui', { rd, imm: hi20(v) }), mk('addi', { rd, rs1: rd, imm: lo12(v) }, addr + 4)];
    }
  }
  throw new LineError(`unknown instruction '${m}'`);
}
