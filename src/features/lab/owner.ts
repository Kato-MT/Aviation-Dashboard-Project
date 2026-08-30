import type { LabSession } from './session';

/** Pure, lazily initialized data ownership that survives route mounts, never a persisted store. */
export class LabSessionOwner {
  private session: LabSession | undefined;

  acquire(create: () => LabSession): LabSession {
    this.session ??= create();
    return this.session;
  }

  stop(): void {
    this.session?.stop();
  }
}
