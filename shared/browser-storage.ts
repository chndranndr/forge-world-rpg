const WRITE_LOCK_NAME = "fworld-write";
let releaseWriteLockFn: (() => void) | undefined;

export type WriteLockStatus = "granted" | "denied" | "unsupported";

export async function acquireWriteLock(
  options: { wait?: boolean } = {},
): Promise<WriteLockStatus> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return "unsupported";
  }
  const outer = Promise.withResolvers<WriteLockStatus>();
  const hold = Promise.withResolvers<void>();
  const requestOptions: LockOptions = options.wait ? {} : { ifAvailable: true };
  void navigator.locks
    .request(WRITE_LOCK_NAME, requestOptions, (lock) => {
      if (!lock) {
        outer.resolve("denied");
        return undefined;
      }
      const release = () => {
        hold.resolve();
        if (releaseWriteLockFn === release) releaseWriteLockFn = undefined;
      };
      releaseWriteLockFn = release;
      outer.resolve("granted");
      return hold.promise;
    })
    .catch(() => outer.resolve("denied"));
  return outer.promise;
}

export function releaseWriteLock(): void {
  releaseWriteLockFn?.();
}

export type PersistenceStatus = "granted" | "denied" | "unsupported";

export async function requestPersistence(): Promise<PersistenceStatus> {
  if (!navigator.storage?.persist) return "unsupported";
  try {
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
