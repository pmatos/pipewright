import renameDemo from '../../programs/rename_demo.s?raw';
import dependentChain from '../../programs/dependent_chain.s?raw';
import independentAdds from '../../programs/independent_adds.s?raw';
import branchy from '../../programs/branchy.s?raw';
import storeForward from '../../programs/store_forward.s?raw';
import factorial from '../../programs/factorial.s?raw';
import strlen from '../../programs/strlen.s?raw';
import bubbleSort from '../../programs/bubble_sort.s?raw';

export interface Example {
  id: string;
  title: string;
  source: string;
  /** What to look for while stepping. */
  hint: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'rename',
    title: 'Register renaming',
    source: renameDemo,
    hint: 'Step to cycles 5 to 7. The MUL is still executing, yet `li t0, 7` gets its own physical register and runs, and `add t3` follows it. Hover a pN chip to see who writes and who reads it. Retirement still happens in program order.',
  },
  {
    id: 'chain',
    title: 'Dependent chain (latency-bound)',
    source: dependentChain,
    hint: 'Each MUL waits in the issue queue for the previous one: look for "waits … not ready". Switch the machine to big: IPC barely moves, because width cannot beat a dependence chain.',
  },
  {
    id: 'independent',
    title: 'Independent adds (width-bound)',
    source: independentAdds,
    hint: 'Four accumulators never wait for each other, so several instructions issue every cycle. Compare narrow, teaching and big: IPC follows the width.',
  },
  {
    id: 'branchy',
    title: 'Branch prediction',
    source: branchy,
    hint: 'Use "Next mispredict" to jump to each flush: the wrong-path instructions turn red, the RAT is restored from a checkpoint and fetch restarts. Then try the predictors: none (fetch waits at every branch), not-taken, bimodal and gshare.',
  },
  {
    id: 'forward',
    title: 'Store-to-load forwarding',
    source: storeForward,
    hint: 'The store only writes memory when it retires, but the load issues earlier and takes the value straight from the store. Look for the forwarding event.',
  },
  {
    id: 'factorial',
    title: 'Calls and returns',
    source: factorial,
    hint: 'Every `call` pushes the return address on the return address stack (bottom of the predictor panel) and every `ret` pops it, so returns are predicted correctly.',
  },
  { id: 'strlen', title: 'String length', source: strlen, hint: 'A pointer walk with byte loads and a loop branch.' },
  { id: 'bubble', title: 'Bubble sort', source: bubbleSort, hint: 'Loads, stores and data-dependent branches together. A long run: use the slider.' },
];
