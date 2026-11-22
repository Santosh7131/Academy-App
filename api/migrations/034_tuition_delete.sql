-- Deleting a tuition (22 Nov 2026). The owner can delete the tuition and everything in it (POST /teacher/tuition/delete). The money
-- that came in stays on record: a credit line that added credit (kind topup or by_hand) outlives its tuition, with the tuition's
-- name kept on it, so the developer can still tell whose payment it was. Every other line goes with the tuition, as before.
--
--   credit_ledger.client_name   the tuition's name, written on its money-in lines when it is deleted.
--
-- Only changes how a deleted tuition's lines are kept, so the API from before keeps working against it.

alter table credit_ledger add column if not exists client_name text;
alter table credit_ledger alter column tuition_id drop not null;
alter table credit_ledger drop constraint if exists credit_ledger_tuition_id_fkey;
alter table credit_ledger add constraint credit_ledger_tuition_id_fkey foreign key (tuition_id) references tuitions(id) on delete set null;
-- A line without its tuition is money that came in, with the name of the tuition it came from.
alter table credit_ledger drop constraint if exists credit_ledger_kept_lines;
alter table credit_ledger add constraint credit_ledger_kept_lines check (tuition_id is not null or (kind in ('topup', 'by_hand') and client_name is not null));
