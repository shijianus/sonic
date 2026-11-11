export function isEventEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export class EventEpochMismatchError extends Error {
  constructor(readonly eventEpoch: string | null) {
    super('The event batch predates the current recommendation profile');
  }
}
