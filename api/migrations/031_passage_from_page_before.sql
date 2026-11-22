-- A passage, case study or set of facts printed on one page can serve questions on the next (app 1.9.0): a case study whose last
-- question is on the next page, or a passage printed alone at the foot of a page with all its questions after it. Pages are read one
-- at a time, so the server hands the passage on to those questions once both pages are read (carryPassages in routes/papers.ts).
--   paper_pages.passage_end: a passage printed alone at the foot of the page (the page read gives it as an item of its own).
--   paper_drafts.passage_prev: the question was given the passage from the page before, so it is never given it twice.
-- Whether a question needs its figure is decided by the answer checks, whatever the reader said, except when the tutor has said so
-- herself: paper_drafts.figure_by is 'tutor' then (the checks never undo it), null otherwise. Rewording a question or confirming its
-- words does not make its figure hers.
--
-- Only adds columns, with defaults, so the API from before keeps working against it: run it before the new API is deployed.

alter table paper_pages add column if not exists passage_end text;
alter table paper_drafts add column if not exists passage_prev boolean not null default false;
alter table paper_drafts add column if not exists figure_by text;
