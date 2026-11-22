-- Deleting a tuition in any way keeps its payments on record: the owner's delete, a check's clean-up, or a delete run by hand.
--
-- Migration 034 keeps top-ups and credit added by hand when their tuition goes (tuition_id becomes null and the tuition's
-- name stays in client_name), and allows no other ledger line without a tuition. The owner's delete
-- (POST /teacher/tuition/delete) tidies the ledger first, but any other delete of a tuition left the free start and the
-- AI charges behind with no tuition, which that rule refuses, so the delete failed. This does the same tidying for
-- every delete, just before the tuition goes.

create or replace function credit_ledger_before_tuition_delete() returns trigger
language plpgsql as $$
begin
  update credit_ledger set client_name = coalesce(client_name, old.name)
   where tuition_id = old.id and kind in ('topup', 'by_hand');
  delete from credit_ledger where tuition_id = old.id and kind not in ('topup', 'by_hand');
  return old;
end $$;

drop trigger if exists tuitions_keep_payments on tuitions;
create trigger tuitions_keep_payments before delete on tuitions
  for each row execute function credit_ledger_before_tuition_delete();
