import type { ThreadleafBridge } from "../shared/contracts";

declare global {
  interface Window {
    threadleaf: ThreadleafBridge;
  }
}
