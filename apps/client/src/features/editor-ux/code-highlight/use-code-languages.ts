import { useSyncExternalStore } from "react";
import { getCodeLanguages, subscribeCodeLanguages } from "./lowlight";

/**
 * CCC (issue #407): the code-block language list, re-rendering when the lazy grammars register. The
 * refresh transaction alone does not re-render a ReactNodeView (its node is unchanged), and Mantine's
 * Select shows nothing for a value missing from `data`, so without this a block's language would read
 * "auto" until the user touched it.
 */
export function useCodeLanguages(): string[] {
  return useSyncExternalStore(subscribeCodeLanguages, getCodeLanguages);
}
