-- SeatSync load-test invariants (Sprint 5, Rule 3).
--
-- Run against the database the load scenarios used (0 rows from every query is
-- correct; any row is a broken invariant):
--
--   Get-Content load\invariants.sql -Raw |
--     docker exec -i seatsync-db-1 psql -U seatsync -d seatsync -f -
--
--   docker exec -i seatsync-db-1 psql -U seatsync -d seatsync -f - < load/invariants.sql
--
-- or directly from the host with:
--   psql "$DATABASE_URL" -f load/invariants.sql
--
-- The file intentionally has no transaction wrapper: it only reads, and each
-- query is a separate zero-row proof.

\echo '1. seats with more than one CONFIRMED booking_seats row'
SELECT bs.seat_id AS seat_id,
       count(*)   AS confirmed_bookings
  FROM booking_seats bs
  JOIN bookings b ON b.id = bs.booking_id
 WHERE b.status = 'CONFIRMED'
 GROUP BY bs.seat_id
HAVING count(*) > 1;

\echo '2. BOOKED seats without a matching CONFIRMED booking'
SELECT s.id     AS seat_id,
       s.status AS seat_status
  FROM seats s
 WHERE s.status = 'BOOKED'
   AND NOT EXISTS (
     SELECT 1
       FROM booking_seats bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.seat_id = s.id
        AND b.status = 'CONFIRMED'
   );

\echo '3. seats of CONFIRMED bookings that are not BOOKED'
SELECT s.id     AS seat_id,
       s.status AS seat_status,
       b.id     AS booking_id
  FROM booking_seats bs
  JOIN bookings b ON b.id = bs.booking_id
  JOIN seats s    ON s.id = bs.seat_id
 WHERE b.status = 'CONFIRMED'
   AND s.status <> 'BOOKED';
