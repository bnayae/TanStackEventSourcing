import Dexie, { type Table } from 'dexie';
import type { DBEvent } from './DBEvent.js';

export class FundsDatabase extends Dexie {
  events!: Table<DBEvent, string>;

  constructor() {
    super('FundsDatabase');

    this.version(1).stores({
      // Indexes: id (primary key), accountId, createdAt, sequenceNumber, status, [accountId+sequenceNumber]
      events: 'id, accountId, createdAt, sequenceNumber, status, [accountId+sequenceNumber]',
    });
  }
}
