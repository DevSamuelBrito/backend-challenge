export const ID_GENERATOR = Symbol("ID_GENERATOR");

export interface IdGenerator {
  next(): string;
}
