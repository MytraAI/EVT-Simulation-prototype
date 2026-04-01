import { useStore } from "../store";
import type { SimState } from "../simulation/types";

/**
 * Returns the sim state to display: the scrubbed history frame
 * if scrubbing, otherwise the live sim state.
 */
export function useDisplayState(): SimState | null {
  const simState = useStore((s) => s.simState);
  const history = useStore((s) => s.history);
  const scrubIndex = useStore((s) => s.scrubIndex);

  if (scrubIndex !== null && history[scrubIndex]) {
    return history[scrubIndex];
  }
  return simState;
}
