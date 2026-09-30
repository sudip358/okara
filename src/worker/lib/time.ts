export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const iso = (d: Date) => d.toISOString();
/** YYYY-MM-DD in UTC. */
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDay(d);
}

export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}
