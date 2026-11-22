-- A question can have four to six options (app 1.9.0, build 13): the paper decides, as when one prints an Assertion and Reason key
-- of five choices, (a) to (e). The option marks (right answer, the AI's proposal, a student's pick) can reach the sixth option too.
--
-- Only widens what is allowed, so the API from before keeps working against it: run it before the new API is deployed. Four stays the
-- fewest, on purpose: a question read with three options is a question cut off or misread, and is held for the tutor. The right
-- option of a question must be one of its options.

alter table questions drop constraint if exists questions_options_check;
alter table questions add constraint questions_options_check check (array_length(options, 1) between 4 and 6);
alter table questions drop constraint if exists questions_correct_option_check;
alter table questions add constraint questions_correct_option_check check (correct_option between 0 and 5 and correct_option < array_length(options, 1));

alter table paper_drafts drop constraint if exists paper_drafts_correct_option_check;
alter table paper_drafts add constraint paper_drafts_correct_option_check check (correct_option between 0 and 5);
alter table paper_drafts drop constraint if exists paper_drafts_proposed_option_check;
alter table paper_drafts add constraint paper_drafts_proposed_option_check check (proposed_option between 0 and 5);

alter table answers drop constraint if exists answers_chosen_option_check;
alter table answers add constraint answers_chosen_option_check check (chosen_option between 0 and 5);
