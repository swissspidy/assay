/**
 * A string table: each distinct string gets a small integer id, so columns of the evidence
 * store hold numbers and two strings compare as two ids (ADR 0015).
 */
export class Interner {
  private readonly ids = new Map<string, number>();
  readonly strings: string[] = [];

  /** The id of `s`, adding it when new. */
  intern(s: string): number {
    let id = this.ids.get(s);
    if (id === undefined) {
      id = this.strings.length;
      this.ids.set(s, id);
      this.strings.push(s);
    }
    return id;
  }

  /** The id of `s`, or -1 when the table does not hold it (nothing in the store has that string). */
  lookup(s: string): number {
    return this.ids.get(s) ?? -1;
  }

  get size(): number {
    return this.strings.length;
  }
}
