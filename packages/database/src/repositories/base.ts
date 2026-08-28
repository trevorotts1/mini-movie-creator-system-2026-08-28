import type { SqliteDatabase, SqlOutputValue } from "../connection/index.js";

/**
 * Base contract every MMCS repository implements (spec §25: repositories
 * designed so a PostgreSQL migration later is practical). Implementations
 * hold their own `SqliteDatabase`; the interface stays driver-neutral —
 * no SQLite types leak through it.
 */
export interface Repository {
  /** Stable repository name for logging and registry wiring. */
  readonly name: string;
}

/**
 * Row mapper: converts a raw driver row into a domain record. Repositories
 * keep mapping at the edge so domain types never carry SQL column shapes.
 */
export type RowMapper<Row, Domain> = (row: Record<string, SqlOutputValue>) => Domain;

/**
 * Minimal CRUD surface shared by simple reference-table repositories.
 * Schema tasks (CORE-004..007) extend their own interfaces rather than
 * forcing every aggregate through one widest-common-denominator shape.
 */
export interface CrudRepository<ID, Entity, Patch> extends Repository {
  create(entity: Entity): Entity;
  findById(id: ID): Entity | undefined;
  update(id: ID, patch: Patch): Entity | undefined;
  delete(id: ID): boolean;
  list(): Entity[];
}

/** Shared base holding the connection and row-mapping helpers. */
export abstract class BaseRepository implements Repository {
  protected readonly db: SqliteDatabase;

  abstract readonly name: string;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  protected mapRow<Row, Domain>(row: Record<string, SqlOutputValue> | undefined, mapper: RowMapper<Row, Domain>): Domain | undefined {
    if (row === undefined) {
      return undefined;
    }
    return mapper(row);
  }
}