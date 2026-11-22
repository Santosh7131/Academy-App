-- A new database starts with no tuition.
--
-- Migration 012 gave the data that existed when tuitions arrived to a first tuition (id ...0a1), named from
-- the old 'tuition_name' setting. On a database that held no data, that is an empty tuition nobody owns, with
-- another product's name. It goes here, with the setting that only the apps from before tuitions read, so every
-- tuition is made by a tutor signing up. A database where the first tuition has members or work keeps it.

do $$
declare
  first constant uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  if exists (select 1 from tuitions where id = first)
     and not exists (select 1 from memberships where tuition_id = first)
     and not exists (select 1 from tests where tuition_id = first)
     and not exists (select 1 from questions where tuition_id = first)
     and not exists (select 1 from papers where tuition_id = first)
     and not exists (select 1 from chapters where tuition_id = first) then
    delete from tuitions where id = first;
    delete from app_settings where key = 'tuition_name';
  end if;
end $$;
