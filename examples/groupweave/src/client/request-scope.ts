export interface UiAction {
  /** Begin a new visible identity/group scope while retaining the action lock. */
  transition(): () => boolean;
  capture(): () => boolean;
  isCurrent(): boolean;
  /** Only this action may release its lock; a stale finally cannot release another. */
  finish(): boolean;
}

/** Guards browser state commits, not server authorization or business execution. */
export function createRequestScope() {
  let epoch = 0;
  let nextAction = 0;
  let active: number | undefined;
  return {
    invalidate() { epoch++; active = undefined; },
    begin(): UiAction | undefined {
      if (active !== undefined) return undefined;
      const id = ++nextAction;
      active = id;
      let actionEpoch = epoch;
      const isCurrent = () => active === id && epoch === actionEpoch;
      const capture = () => {
        const requestEpoch = epoch;
        return () => active === id && epoch === requestEpoch;
      };
      return {
        transition() {
          if (active === id) actionEpoch = ++epoch;
          return capture();
        },
        capture,
        isCurrent,
        finish() {
          if (!isCurrent()) return false;
          active = undefined;
          return true;
        },
      };
    },
  };
}
