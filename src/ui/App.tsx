import { useState } from 'react';
import { AssemblerError, assemble, formatInstr, hex, regName, runProgram, type RunResult } from '../core';

const EXAMPLE = `# Sum the words in an array.
    .data
arr:    .word 3, 1, 4, 1, 5, 9, 2, 6
len:    .word 8

    .text
main:
    la   a1, arr
    lw   a2, len
    li   a0, 0
loop:
    lw   t0, 0(a1)
    add  a0, a0, t0
    addi a1, a1, 4
    addi a2, a2, -1
    bnez a2, loop
    ecall              # halt; result in a0
`;

type Outcome =
  | { kind: 'ok'; result: RunResult; listing: string[] }
  | { kind: 'error'; message: string };

function simulate(source: string): Outcome {
  try {
    const program = assemble(source);
    const result = runProgram(program);
    const listing = program.instrs.map((i) => `${hex(i.pc).padStart(10)}  ${formatInstr(i)}`);
    return { kind: 'ok', result, listing };
  } catch (e) {
    if (e instanceof AssemblerError) return { kind: 'error', message: e.message };
    throw e;
  }
}

export function App() {
  const [source, setSource] = useState(EXAMPLE);
  const [outcome, setOutcome] = useState<Outcome>(() => simulate(EXAMPLE));

  return (
    <main>
      <header>
        <h1>Pipewright</h1>
        <p>A configurable CPU microarchitecture simulator. Milestone 1: assembler and functional interpreter.</p>
      </header>
      <section className="grid">
        <div>
          <h2>Program</h2>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} rows={24} />
          <button onClick={() => setOutcome(simulate(source))}>Assemble and run</button>
        </div>
        <div>
          {outcome.kind === 'error' ? (
            <>
              <h2>Errors</h2>
              <pre className="error">{outcome.message}</pre>
            </>
          ) : (
            <>
              <h2>Result</h2>
              <p>
                Halted by <code>{outcome.result.halt}</code> after {outcome.result.retired} instructions.
              </p>
              <table>
                <tbody>
                  {Array.from({ length: 8 }, (_, row) => (
                    <tr key={row}>
                      {Array.from({ length: 4 }, (_, col) => {
                        const r = row * 4 + col;
                        return (
                          <td key={r}>
                            <span className="reg">{regName(r)}</span> {outcome.result.state.regs[r]}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <h2>Assembled</h2>
              <pre>{outcome.listing.join('\n')}</pre>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
