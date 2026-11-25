export type CanvasIdentity = {
  package: string;
  root: string;
  namespace: string;
  branch: string;
  empty: boolean;
};

/**
 * One canvas's asynchronous lifecycle. Refreshes supersede reads, while navigation
 * also ends the editing context. Saving an edit must survive a refresh but must
 * never reopen a canvas the user has left.
 */
export function createCanvasSession() {
  let identity: CanvasIdentity | null = null;
  let requestVersion = 0;
  let contextVersion = 0;
  const captureRequest = () => {
    const version = requestVersion;
    return () => version === requestVersion;
  };
  return {
    matches(next: CanvasIdentity) {
      return identity !== null && identity.package === next.package && identity.root === next.root &&
        identity.namespace === next.namespace && identity.branch === next.branch && identity.empty === next.empty;
    },
    invalidate(next: CanvasIdentity | null = identity) {
      identity = next ? { ...next } : null;
      contextVersion += 1;
      requestVersion += 1;
    },
    updateRoot(root: string) {
      if (identity) identity = { ...identity, root };
    },
    captureContext() {
      const version = contextVersion;
      return () => version === contextVersion;
    },
    captureRequest,
    beginRequest() {
      requestVersion += 1;
      return captureRequest();
    },
    invalidateRequests() {
      requestVersion += 1;
    },
  };
}
