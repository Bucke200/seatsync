import type { SeatStatus } from "@seatsync/shared";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export interface SectionSeatInput {
  name: string;
  rows: number;
  seatsPerRow: number;
  pricePaise: number;
}

export interface SeatRecord {
  id: string;
  section: string;
  rowLabel: string;
  number: number;
  pricePaise: number;
  status: SeatStatus;
}

interface SeatRow extends QueryResultRow {
  id: string;
  section: string;
  row_label: string;
  number: number;
  price_paise: number;
  status: SeatStatus;
}

/**
 * Insert one section's seats inside the caller's transaction. Row labels are
 * `R1..R{rows}` and seat numbers `1..seatsPerRow`; every value is a bound
 * parameter, never interpolated text.
 */
export async function insertSectionSeats(
  client: PoolClient,
  eventId: string,
  section: SectionSeatInput,
): Promise<void> {
  const tuples: string[] = [];
  // $1 = event_id, $2 = section, $3 = price_paise; each seat adds two params.
  const params: Array<string | number> = [eventId, section.name, section.pricePaise];

  for (let row = 1; row <= section.rows; row += 1) {
    for (let number = 1; number <= section.seatsPerRow; number += 1) {
      params.push(`R${row}`, number);
      tuples.push(`($1, $2, $${params.length - 1}, $${params.length}, $3)`);
    }
  }

  if (tuples.length === 0) {
    return;
  }

  await client.query(
    `INSERT INTO seats (event_id, section, row_label, number, price_paise)
     VALUES ${tuples.join(", ")}`,
    params,
  );
}

export async function listSeatsByEventId(pool: Pool, eventId: string): Promise<SeatRecord[]> {
  const result = await pool.query<SeatRow>(
    `SELECT id, section, row_label, number, price_paise, status
       FROM seats
      WHERE event_id = $1
      ORDER BY section ASC, row_label ASC, number ASC`,
    [eventId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    section: row.section,
    rowLabel: row.row_label,
    number: row.number,
    pricePaise: row.price_paise,
    status: row.status,
  }));
}
